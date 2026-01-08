package org.console;

import com.jcraft.jsch.Channel;
import com.jcraft.jsch.ChannelExec;
import com.jcraft.jsch.ChannelShell;
import com.jcraft.jsch.JSch;
import com.jcraft.jsch.Session;
import com.jcraft.jsch.SftpProgressMonitor;
import io.vertx.core.AbstractVerticle;
import io.vertx.core.Future;
import io.vertx.core.Promise;
import io.vertx.core.eventbus.Message;
import io.vertx.core.json.JsonArray;
import io.vertx.core.json.JsonObject;
import io.vertx.redis.client.Command;
import io.vertx.redis.client.Redis;
import io.vertx.redis.client.Request;
import org.console.utils.ShellUtils;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;

import static org.console.Constants.*;

public class SshVerticle extends AbstractVerticle {
    private static final Logger logger = LoggerFactory.getLogger(SshVerticle.class);
    private final Redis redis;
    private final Map<String, SshSession> sessions = new ConcurrentHashMap<>();
    private Map<String, JsonObject> serverConfigs;
    private Map<String, JsonObject> userConfigs;
    private final Map<String, Session> jschSessions = new ConcurrentHashMap<>();
    private final Map<String, Integer> sessionReferences = new ConcurrentHashMap<>();
    private final Map<String, JsonObject> restorableSessions = new ConcurrentHashMap<>();
    private final Map<String, JsonObject> dockerCache = new ConcurrentHashMap<>();
    private final Map<String, Future<String>> pendingDockerRequests = new ConcurrentHashMap<>();
    private final java.util.Set<String> connectingSessions = java.util.Collections.newSetFromMap(new ConcurrentHashMap<>());
    private final Semaphore dockerApiSemaphore = new Semaphore(15);

    public SshVerticle(Redis redis, Map<String, JsonObject> serverConfigs, Map<String, JsonObject> userConfigs) {
        this.redis = redis;
        this.serverConfigs = serverConfigs;
        this.userConfigs = userConfigs;
    }

    @Override
    public void start(Promise<Void> startPromise) {
        // Слушаем команды ввода
        vertx.eventBus().<JsonObject>consumer(SSH_COMMAND_IN, message -> {
            Object bodyObj = message.body();
            if (!(bodyObj instanceof JsonObject)) return;
            JsonObject body = (JsonObject) bodyObj;
            String sessionId = body.getString("sessionId");
            String data = body.getString("data");
            String userId = body.getString("userId");
            SshSession session = sessions.get(sessionId);
            if (session != null) {
                if (userId != null && userId.equals(session.userId)) {
                    session.write(data);
                } else {
                    logger.warn("Unauthorized command access for session {} by user id {}", sessionId, userId);
                }
            } else {
                logger.warn("Session not found: {}", sessionId);
            }
        });

        // Установка режима отображения (terminal/docker)
        vertx.eventBus().<JsonObject>consumer(SSH_SESSION_VIEWMODE_SET, message -> {
            JsonObject body = message.body();
            String sessionId = body.getString("sessionId");
            String viewMode = body.getString("viewMode");
            String userId = body.getString(SESSION_USER_ID);

            if (userId == null) {
                message.fail(401, "User ID missing");
                return;
            }

            SshSession session = sessions.get(sessionId);
            JsonObject restorableConfig = restorableSessions.get(sessionId);
            
            String serverId = null;
            String oldViewMode = null;
            if (session != null && userId.equals(session.userId)) {
                serverId = session.serverId;
                oldViewMode = session.viewMode;
                session.viewMode = viewMode;
            } else if (restorableConfig != null && userId.equals(restorableConfig.getString(SESSION_USER_ID))) {
                serverId = restorableConfig.getString("serverId");
                oldViewMode = restorableConfig.getString("viewMode");
                restorableConfig.put("viewMode", viewMode);
            }

            if (serverId != null) {
                // Если уходим из режима docker или files, закрываем дочерние докер-сессии
                if (!viewMode.equals(oldViewMode) && ("docker".equals(oldViewMode) || "files".equals(oldViewMode))) {
                    terminateChildDockerSessions(userId, serverId, sessionId);
                }

                // Если устанавливаем docker или files, сбрасываем остальные у этого сервера
                if ("docker".equals(viewMode) || "files".equals(viewMode)) {
                    final String srvId = serverId;
                    final String targetMode = viewMode;
                    sessions.values().forEach(s -> {
                        if (userId.equals(s.userId) && srvId.equals(s.serverId) && !sessionId.equals(s.sessionId) && targetMode.equals(s.viewMode)) {
                            s.viewMode = "terminal";
                            saveViewModeToRedis(s.sessionId, "terminal");
                        }
                    });
                    restorableSessions.values().forEach(c -> {
                        if (userId.equals(c.getString(SESSION_USER_ID)) && srvId.equals(c.getString("serverId")) && !sessionId.equals(c.getString("sessionId")) && targetMode.equals(c.getString("viewMode"))) {
                            c.put("viewMode", "terminal");
                            saveViewModeToRedis(c.getString("sessionId"), "terminal");
                        }
                    });
                }
                saveViewModeToRedis(sessionId, viewMode);
                message.reply(new JsonObject().put("status", "ok"));
            } else {
                message.fail(404, "Session not found");
            }
        });

        // Docker API consumers
        registerDockerConsumers();

        // Files consumers
        registerFilesConsumers();

        // Список серверов для фронтенда
        vertx.eventBus().consumer(SSH_SERVERS_LIST, message -> {
            JsonArray list = new JsonArray();
            serverConfigs.values().forEach(cfg -> {
                list.add(new JsonObject()
                    .put("id", cfg.getString("id"))
                    .put("name", cfg.getString("name")));
            });
            message.reply(list);
        });

        // Создание сессии
        vertx.eventBus().<JsonObject>consumer(SSH_SESSION_CREATE, message -> {
            Object bodyObj = message.body();
            if (!(bodyObj instanceof JsonObject)) return;
            JsonObject body = (JsonObject) bodyObj;
            
            String serverId = body.getString("serverId");
            String sessionId = body.getString("sessionId");
            String userId = body.getString(SESSION_USER_ID);

            if (userId == null) {
                message.fail(401, "User ID is missing");
                return;
            }

            JsonObject serverConfig = serverConfigs.get(serverId);
            if (serverConfig == null) {
                message.fail(404, "Server configuration not found: " + serverId);
                return;
            }
            
            if (sessions.containsKey(sessionId) || connectingSessions.contains(sessionId)) {
                message.reply(new JsonObject().put("status", "already_connected"));
                return;
            }

            connectingSessions.add(sessionId);

            // Проверка лимита сессий для пользователя на данном сервере
            String command = body.getString("command");
            boolean isDocker = isDockerCommand(command);
            
            if (!checkSessionLimit(userId, serverId, isDocker, message)) {
                connectingSessions.remove(sessionId);
                return;
            }

            // Создаем полный конфиг для подключения, включая пароль
            JsonObject fullConfig = serverConfig.copy()
                .put("sessionId", sessionId)
                .put("serverId", serverId)
                .put(SESSION_USER_ID, userId)
                .put("command", command)
                .put("viewMode", body.getString("viewMode", "terminal"))
                .put("isDocker", isDocker)
                .put("name", body.getString("name", serverConfig.getString("name")));

            connectSsh(fullConfig, sessionId, serverId, userId)
                .onComplete(ar -> connectingSessions.remove(sessionId))
                .onSuccess(v -> {
                    if (isDocker && !hasDockerView(userId, serverId)) {
                        logger.warn("Discarding docker terminal {} because parent Docker View for server {} was closed", sessionId, serverId);
                        SshSession s = sessions.remove(sessionId);
                        if (s != null) {
                            closeSshSession(s);
                        }
                        message.fail(410, "Docker view closed");
                        return;
                    }
                    saveSessionToRedis(fullConfig);
                    message.reply(new JsonObject().put("status", "connected"));
                    notifySessionCreated(userId, sessionId, serverId, fullConfig.getString("name"), isDocker, fullConfig.getString("viewMode", "terminal"));
                })
                .onFailure(err -> {
                    logger.error("SSH connection failed", err);
                    message.fail(500, err.getMessage());
                });
        });

        // Восстановление сессии по запросу
        vertx.eventBus().<JsonObject>consumer(SSH_SESSION_RESTORE, message -> {
            Object bodyObj = message.body();
            if (!(bodyObj instanceof JsonObject)) {
                logger.warn("Invalid body for restore session: {}", bodyObj);
                return;
            }
            JsonObject body = (JsonObject) bodyObj;
            String sessionId = body.getString("sessionId");
            String userId = body.getString(SESSION_USER_ID);

            logger.info("Restore session request received: sessionId={}, userId={}", sessionId, userId);

            if (sessions.containsKey(sessionId) || connectingSessions.contains(sessionId)) {
                logger.info("Session {} already connecting or active", sessionId);
                message.reply(new JsonObject().put("status", "already_connected"));
                return;
            }

            JsonObject config = restorableSessions.get(sessionId);
            if (config != null) {
                if (userId != null && userId.equals(config.getString(SESSION_USER_ID))) {
                    connectingSessions.add(sessionId);
                    String serverId = config.getString("serverId");
                    String cmd = config.getString("command", "");
                    boolean isDocker = config.getBoolean("isDocker", isDockerCommand(cmd));
                    logger.info("Restoring session on demand: {} for user id {}", sessionId, userId);
                    connectSsh(config, sessionId, serverId, userId)
                        .onComplete(ar -> {
                            connectingSessions.remove(sessionId);
                            logger.info("Restore session complete: sessionId={}, success={}", sessionId, ar.succeeded());
                        })
                        .onSuccess(v -> {
                            if (isDocker && !hasDockerView(userId, serverId)) {
                                logger.warn("Discarding restored docker terminal {} because parent Docker View for server {} was closed", sessionId, serverId);
                                SshSession s = sessions.remove(sessionId);
                                if (s != null) {
                                    closeSshSession(s);
                                }
                                message.fail(410, "Docker view closed");
                                return;
                            }
                            message.reply(new JsonObject().put("status", "connected"));
                            notifySessionCreated(userId, sessionId, serverId, config.getString("name", serverConfigs.containsKey(serverId) ? serverConfigs.get(serverId).getString("name") : serverId), isDocker, config.getString("viewMode", "terminal"));
                        })
                        .onFailure(err -> {
                            logger.error("Failed to restore session {}", sessionId, err);
                            message.fail(500, err.getMessage());
                        });
                } else {
                    logger.warn("Restore unauthorized: sessionId={}, userId={}", sessionId, userId);
                    message.fail(403, "Not authorized");
                }
            } else {
                logger.warn("Restore failed: metadata not found for sessionId={}", sessionId);
                message.fail(404, "Session metadata not found");
            }
        });

        // Завершение сессии
        vertx.eventBus().<JsonObject>consumer(SSH_SESSION_TERMINATE, message -> {
            Object bodyObj = message.body();
            if (!(bodyObj instanceof JsonObject)) return;
            JsonObject body = (JsonObject) bodyObj;
            String sessionId = body.getString("sessionId");
            String userId = body.getString(SESSION_USER_ID);
            
            SshSession session = sessions.get(sessionId);
            if (session != null && userId != null && userId.equals(session.userId)) {
                String serverId = session.serverId;
                String viewMode = session.viewMode;

                sessions.remove(sessionId);
                closeSshSession(session);
                removeSessionFromRedis(userId, sessionId);
                notifySessionTerminated(userId, sessionId, true);
                logger.info("Session terminated by user id {}: {}", userId, sessionId);

                if ("docker".equals(viewMode)) {
                    terminateChildDockerSessions(userId, serverId, sessionId);
                }

                message.reply(new JsonObject().put("status", "terminated"));
            } else {
                // Проверяем, может это восстанавливаемая сессия, которую нужно просто удалить
                JsonObject config = restorableSessions.get(sessionId);
                if (config != null && userId != null && userId.equals(config.getString(SESSION_USER_ID))) {
                    String serverId = config.getString("serverId");
                    String viewMode = config.getString("viewMode");

                    restorableSessions.remove(sessionId);
                    removeSessionFromRedis(userId, sessionId);
                    notifySessionTerminated(userId, sessionId, true);
                    logger.info("Restorable session removed by user id {}: {}", userId, sessionId);

                    if ("docker".equals(viewMode)) {
                        terminateChildDockerSessions(userId, serverId, sessionId);
                    }

                    message.reply(new JsonObject().put("status", "terminated"));
                } else {
                    message.fail(403, "Not authorized or session not found");
                }
            }
        });

        // Продление сессии (keep-alive)
        vertx.eventBus().<JsonObject>consumer(SSH_SESSION_KEEPALIVE, message -> {
            Object bodyObj = message.body();
            if (!(bodyObj instanceof JsonObject)) return;
            JsonObject body = (JsonObject) bodyObj;
            String sessionId = body.getString("sessionId");
            String userId = body.getString(SESSION_USER_ID);
            if (sessionId != null) {
                SshSession session = sessions.get(sessionId);
                if (session != null && userId != null && userId.equals(session.userId)) {
                    session.lastActivity = System.currentTimeMillis();
                }
            }
        });

        // Список активных сессий (включая восстанавливаемые) с учетом сохраненного порядка
        vertx.eventBus().<JsonObject>consumer(SSH_SESSION_LIST, message -> {
            Object bodyObj = message.body();
            String userId = (bodyObj instanceof JsonObject) ? ((JsonObject) bodyObj).getString(SESSION_USER_ID) : null;

            if (userId == null) {
                message.fail(401, "User ID missing");
                return;
            }

            String orderKey = "ssh:user_order:" + userId;
            redis.send(Request.cmd(Command.LRANGE).arg(orderKey).arg("0").arg("-1"))
                .onComplete(ar -> {
                    List<String> order = new ArrayList<>();
                    if (ar.succeeded() && ar.result() != null) {
                        ar.result().forEach(id -> order.add(id.toString()));
                    }

                    Map<String, JsonObject> allSessions = new HashMap<>();

                    // Собираем активные
                    sessions.values().forEach(s -> {
                        if (userId.equals(s.userId)) {
                            allSessions.put(s.sessionId, new JsonObject()
                                .put("id", s.sessionId)
                                .put("serverId", s.serverId)
                                .put("name", s.name)
                                .put("status", "connected")
                                .put("viewMode", s.viewMode)
                                .put("isDocker", s.isDocker)
                                .put("serverName", serverConfigs.containsKey(s.serverId) ? serverConfigs.get(s.serverId).getString("name") : s.serverId));
                        }
                    });

                    // Собираем восстанавливаемые
                    restorableSessions.forEach((sessionId, config) -> {
                        if (!sessions.containsKey(sessionId)) {
                            String sUserId = config.getString(SESSION_USER_ID);
                            if (userId.equals(sUserId)) {
                                String serverId = config.getString("serverId");
                                String cmd = config.getString("command", "");
                                boolean isDocker = isDockerCommand(cmd);
                                allSessions.put(sessionId, new JsonObject()
                                    .put("id", sessionId)
                                    .put("serverId", serverId)
                                    .put("name", config.getString("name", serverConfigs.containsKey(serverId) ? serverConfigs.get(serverId).getString("name") : serverId))
                                    .put("status", "restorable")
                                    .put("viewMode", config.getString("viewMode", "terminal"))
                                    .put("isDocker", isDocker)
                                    .put("serverName", serverConfigs.containsKey(serverId) ? serverConfigs.get(serverId).getString("name") : serverId));
                            }
                        }
                    });

                    JsonArray resultList = new JsonArray();
                    // Сначала добавляем согласно порядку
                    for (String sid : order) {
                        JsonObject sObj = allSessions.remove(sid);
                        if (sObj != null) {
                            resultList.add(sObj);
                        }
                    }
                    // Добавляем оставшиеся, которые не попали в список порядка
                    allSessions.values().forEach(resultList::add);

                    message.reply(resultList);
                });
        });
        
        // Получение истории вывода сессии
        vertx.eventBus().<JsonObject>consumer(SSH_SESSION_HISTORY, message -> {
            Object bodyObj = message.body();
            if (!(bodyObj instanceof JsonObject)) return;
            JsonObject body = (JsonObject) bodyObj;
            String sessionId = body.getString("sessionId");
            String userId = body.getString(SESSION_USER_ID);

            SshSession session = sessions.get(sessionId);
            if (session != null) {
                if (userId != null && userId.equals(session.userId)) {
                    message.reply(new JsonObject().put("history", session.getOutputHistory()));
                } else {
                    message.fail(403, "Not authorized");
                }
            } else {
                message.fail(404, "Session not found");
            }
        });

        // Пересортировка сессий пользователем
        vertx.eventBus().<JsonObject>consumer(SSH_SESSION_REORDER, message -> {
            Object bodyObj = message.body();
            if (!(bodyObj instanceof JsonObject)) return;
            JsonObject body = (JsonObject) bodyObj;
            String userId = body.getString(SESSION_USER_ID);
            JsonArray order = body.getJsonArray("order");
            if (userId != null && order != null) {
                String key = "ssh:user_order:" + userId;
                redis.send(Request.cmd(Command.DEL).arg(key)).onComplete(ar -> {
                    if (!order.isEmpty()) {
                        Request rpush = Request.cmd(Command.RPUSH).arg(key);
                        for (int i = 0; i < order.size(); i++) {
                            rpush.arg(order.getString(i));
                        }
                        redis.send(rpush).onFailure(err -> logger.error("Failed to update user order in Redis", err));
                    }
                    // Оповещаем другие вкладки этого же пользователя
                    vertx.eventBus().publish(SSH_COMMAND_OUT_PREFIX + userId + SSH_SESSION_REORDERED_SUFFIX, new JsonObject()
                        .put(SESSION_USER_ID, userId)
                        .put("order", order));
                    message.reply(new JsonObject().put("status", "ok"));
                });
            } else {
                message.fail(400, "Missing userId or order");
            }
        });

        // Загрузка метаданных сессий из Redis при старте
        loadRestorableSessions().onComplete(ar -> {
            if (ar.succeeded()) {
                startPromise.complete();
            } else {
                logger.error("Failed to load restorable sessions", ar.cause());
                startPromise.complete(); // Все равно запускаемся
            }
        });

        // Проверка неактивных сессий каждые 30 секунд
        vertx.setPeriodic(30000, id -> checkIdleSessions());
    }

    private void registerDockerConsumers() {
        Map<String, String[]> endpoints = Map.of(
            DOCKER_CONTAINERS_LIST, new String[]{"GET", "/containers/json?all=true"},
            DOCKER_CONTAINER_STATS, new String[]{"GET", "/containers/%s/stats?stream=false"},
            DOCKER_CONTAINER_RESTART, new String[]{"POST", "/containers/%s/restart"},
            DOCKER_CONTAINER_LOGS, new String[]{"GET", "/containers/%s/logs?stdout=true&stderr=true&timestamps=%s&tail=%s"}
        );

        endpoints.forEach((address, params) -> {
            vertx.eventBus().<JsonObject>consumer(address, message -> {
                JsonObject body = message.body();
                String path = params[1];
                if (path.contains("%s")) {
                    String containerId = body.getString("containerId");
                    if (!ShellUtils.isValidContainerId(containerId)) {
                        message.fail(400, "Invalid container ID format");
                        return;
                    }
                    if (address.equals(DOCKER_CONTAINER_LOGS)) {
                        Object tailObj = body.getValue("tail");
                        String tail = tailObj != null ? tailObj.toString() : "200";
                        boolean timestamps = body.getBoolean("timestamps", false);
                        path = String.format(path, containerId, timestamps, tail);
                    } else {
                        path = String.format(path, containerId);
                    }
                }
                dispatchDockerRequest(body.getString("sessionId"), body.getString(SESSION_USER_ID), params[0], path, null, message);
            });
        });
    }

    private void registerFilesConsumers() {
        vertx.eventBus().<JsonObject>consumer(FILES_LIST, message -> {
            JsonObject body = message.body();
            String path = body.getString("path", ".");
            String sessionId = body.getString("sessionId");
            String userId = body.getString(SESSION_USER_ID);

            String serverId = getServerId(sessionId, userId);
            if (serverId == null) {
                message.fail(403, "Access denied");
                return;
            }

            Session jschSession = getAnyActiveJschSession(serverId);
            if (jschSession == null) {
                message.fail(503, "SSH session not active");
                return;
            }

            String sanitizedPath = ShellUtils.sanitize(path);
            String command = String.format("readlink -f %1$s; echo '---LS---'; ls -la --time-style=long-iso %1$s; echo '---DF---'; df -h %1$s | tail -n 1", sanitizedPath);
            executeCommand(jschSession, command)
                .onSuccess(output -> {
                    String[] lsParts = output.split("---LS---");
                    String absolutePath = lsParts[0].trim();
                    String remaining = lsParts.length > 1 ? lsParts[1] : "";

                    String[] parts = remaining.split("---DF---");
                    JsonArray files = parseLsOutput(parts[0]);
                    JsonObject diskInfo = parts.length > 1 ? parseDfOutput(parts[1]) : null;

                    JsonObject reply = new JsonObject()
                        .put("status", "ok")
                        .put("files", files)
                        .put("path", absolutePath.isEmpty() ? path : absolutePath);
                    if (diskInfo != null) {
                        reply.put("diskInfo", diskInfo);
                    }
                    message.reply(reply);
                })
                .onFailure(err -> message.fail(500, err.getMessage()));
        });

        vertx.eventBus().<JsonObject>consumer(FILES_ARCHIVE, message -> {
            JsonObject body = message.body();
            JsonArray paths = body.getJsonArray("paths");
            String sessionId = body.getString("sessionId");
            String userId = body.getString(SESSION_USER_ID);

            String serverId = getServerId(sessionId, userId);
            if (serverId == null) {
                message.fail(403, "Access denied");
                return;
            }

            Session jschSession = getAnyActiveJschSession(serverId);
            if (jschSession == null) {
                message.fail(503, "SSH session not active");
                return;
            }

            String archiveName = "/tmp/archive_" + System.currentTimeMillis() + ".tar.gz";
            StringBuilder sb = new StringBuilder("tar -czf ").append(archiveName);
            for (int i = 0; i < paths.size(); i++) {
                sb.append(" ").append(ShellUtils.sanitize(paths.getString(i)));
            }

            executeCommand(jschSession, sb.toString())
                .onSuccess(v -> message.reply(new JsonObject().put("status", "ok").put("archivePath", archiveName)))
                .onFailure(err -> message.fail(500, err.getMessage()));
        });

        vertx.eventBus().<JsonObject>consumer(FILES_SIZE, message -> {
            JsonObject body = message.body();
            String path = body.getString("path", ".");
            String sessionId = body.getString("sessionId");
            String userId = body.getString(SESSION_USER_ID);

            String serverId = getServerId(sessionId, userId);
            if (serverId == null) {
                message.fail(403, "Access denied");
                return;
            }

            Session jschSession = getAnyActiveJschSession(serverId);
            if (jschSession == null) {
                message.fail(503, "SSH session not active");
                return;
            }

            // Используем du -sh для получения размеров всех объектов в папке
            // || true нужен, так как du возвращает 1, если не нашел какой-то из файлов (например, если папка пустая или нет прав)
            String command = String.format("cd %s && (du -sh -- .[!.]* * 2>/dev/null || true)", ShellUtils.sanitize(path));
            executeCommand(jschSession, command)
                .onSuccess(output -> {
                    JsonObject sizes = new JsonObject();
                    String[] lines = output.split("\n");
                    for (String line : lines) {
                        line = line.trim();
                        if (line.isEmpty()) continue;
                        String[] parts = line.split("\\s+", 2);
                        if (parts.length == 2) {
                            sizes.put(parts[1], parts[0]);
                        }
                    }
                    message.reply(new JsonObject().put("status", "ok").put("sizes", sizes));
                })
                .onFailure(err -> {
                    // Если папка пустая, du может вернуть ошибку
                    if (err.getMessage().contains("No such file or directory") || err.getMessage().contains("Exit status 1")) {
                        message.reply(new JsonObject().put("status", "ok").put("sizes", new JsonObject()));
                    } else {
                        message.fail(500, err.getMessage());
                    }
                });
        });

        vertx.eventBus().<JsonObject>consumer(FILES_MKDIR, message -> {
            JsonObject body = message.body();
            String path = body.getString("path");
            String sessionId = body.getString("sessionId");
            String userId = body.getString(SESSION_USER_ID);

            String serverId = getServerId(sessionId, userId);
            if (serverId == null) {
                message.fail(403, "Access denied");
                return;
            }

            Session jschSession = getAnyActiveJschSession(serverId);
            if (jschSession == null) {
                message.fail(503, "SSH session not active");
                return;
            }

            String command = String.format("mkdir -p %s", ShellUtils.sanitize(path));
            executeCommand(jschSession, command)
                .onSuccess(v -> {
                    message.reply(new JsonObject().put("status", "ok"));
                    notifyFilesChanged(userId, serverId, path);
                })
                .onFailure(err -> message.fail(500, err.getMessage()));
        });

        vertx.eventBus().<JsonObject>consumer(FILES_DELETE, message -> {
            JsonObject body = message.body();
            JsonArray paths = body.getJsonArray("paths");
            String sessionId = body.getString("sessionId");
            String userId = body.getString(SESSION_USER_ID);

            String serverId = getServerId(sessionId, userId);
            if (serverId == null) {
                message.fail(403, "Access denied");
                return;
            }

            Session jschSession = getAnyActiveJschSession(serverId);
            if (jschSession == null) {
                message.fail(503, "SSH session not active");
                return;
            }

            StringBuilder sb = new StringBuilder("rm -rf");
            for (int i = 0; i < paths.size(); i++) {
                sb.append(" ").append(ShellUtils.sanitize(paths.getString(i)));
            }

            executeCommand(jschSession, sb.toString())
                .onSuccess(v -> {
                    message.reply(new JsonObject().put("status", "ok"));
                    for (int i = 0; i < paths.size(); i++) {
                        notifyFilesChanged(userId, serverId, paths.getString(i));
                    }
                })
                .onFailure(err -> message.fail(500, err.getMessage()));
        });

        vertx.eventBus().<JsonObject>consumer(FILES_CHMOD, message -> {
            JsonObject body = message.body();
            String path = body.getString("path");
            String mode = body.getString("mode");
            String sessionId = body.getString("sessionId");
            String userId = body.getString(SESSION_USER_ID);

            String serverId = getServerId(sessionId, userId);
            if (serverId == null) {
                message.fail(403, "Access denied");
                return;
            }

            Session jschSession = getAnyActiveJschSession(serverId);
            if (jschSession == null) {
                message.fail(503, "SSH session not active");
                return;
            }

            String command = String.format("chmod %s %s", ShellUtils.sanitize(mode), ShellUtils.sanitize(path));
            executeCommand(jschSession, command)
                .onSuccess(v -> message.reply(new JsonObject().put("status", "ok")))
                .onFailure(err -> message.fail(500, err.getMessage()));
        });

        vertx.eventBus().<JsonObject>consumer(FILES_COPY, message -> {
            JsonObject body = message.body();
            String srcPath = body.getString("srcPath");
            String destPath = body.getString("destPath");
            String srcSessionId = body.getString("srcSessionId");
            String destSessionId = body.getString("destSessionId");
            String userId = body.getString(SESSION_USER_ID);
            String taskId = body.getString("taskId");

            String srcServerId = getServerId(srcSessionId, userId);
            String destServerId = getServerId(destSessionId, userId);

            if (srcServerId == null || destServerId == null) {
                message.fail(403, "Access denied");
                return;
            }

            if (srcServerId.equals(destServerId)) {
                // Локальное копирование на одном сервере
                Session jschSession = getAnyActiveJschSession(srcServerId);
                if (jschSession == null) {
                    message.fail(503, "SSH session not active");
                    return;
                }
                String command = String.format("cp -r %s %s", ShellUtils.sanitize(srcPath), ShellUtils.sanitize(destPath));
                executeCommand(jschSession, command)
                    .onSuccess(v -> {
                        sendCopyProgress(userId, taskId, srcPath, "done", 100);
                        message.reply(new JsonObject().put("status", "ok"));
                        notifyFilesChanged(userId, destServerId, destPath);
                    })
                    .onFailure(err -> message.fail(500, err.getMessage()));
            } else {
                String method = body.getString("method", "stream");
                if ("direct".equals(method)) {
                    tryDirectCopy(srcServerId, destServerId, srcPath, destPath)
                        .onSuccess(v -> {
                            sendCopyProgress(userId, taskId, srcPath, "done", 100);
                            message.reply(new JsonObject().put("status", "ok"));
                            notifyFilesChanged(userId, destServerId, destPath);
                        })
                        .onFailure(err -> {
                            logger.info("Direct copy failed, falling back to streaming: {}", err.getMessage());
                            sendCopyProgress(userId, taskId, srcPath, "fallback", 0, err.getMessage());
                            performStreamingCopy(srcServerId, destServerId, srcPath, destPath, userId, taskId, message);
                        });
                } else {
                    performStreamingCopy(srcServerId, destServerId, srcPath, destPath, userId, taskId, message);
                }
            }
        });

        vertx.eventBus().<JsonObject>consumer(FILES_CHECK_TOOLS, message -> {
            JsonObject body = message.body();
            String sessionId = body.getString("sessionId");
            String userId = body.getString(SESSION_USER_ID);

            String serverId = getServerId(sessionId, userId);
            if (serverId == null) {
                message.fail(403, "Access denied");
                return;
            }

            Session jschSession = getAnyActiveJschSession(serverId);
            if (jschSession == null) {
                message.fail(503, "SSH session not active");
                return;
            }

            // Проверяем scp и sshpass
            executeCommand(jschSession, "which scp && which sshpass")
                .onSuccess(v -> message.reply(new JsonObject().put("status", "ok").put("available", true)))
                .onFailure(err -> message.reply(new JsonObject().put("status", "ok").put("available", false).put("error", err.getMessage())));
        });

        vertx.eventBus().<JsonObject>consumer(FILES_INSTALL_TOOLS, message -> {
            JsonObject body = message.body();
            String sessionId = body.getString("sessionId");
            String userId = body.getString(SESSION_USER_ID);
            String taskId = body.getString("taskId");

            String serverId = getServerId(sessionId, userId);
            if (serverId == null) {
                message.fail(403, "Access denied");
                return;
            }

            Session jschSession = getAnyActiveJschSession(serverId);
            if (jschSession == null) {
                message.fail(503, "SSH session not active");
                return;
            }

            message.reply(new JsonObject().put("status", "ok"));
            
            sendCopyProgress(userId, taskId, "Установка инструментов (scp, sshpass)", "copying", 10);
            
            // Пытаемся определить менеджер пакетов и установить
            String installCmd = "(command -v apt-get >/dev/null && apt-get update && apt-get install -y openssh-client sshpass) || " +
                               "(command -v yum >/dev/null && yum install -y openssh-clients sshpass) || " +
                               "(command -v apk >/dev/null && apk add openssh-client sshpass) || " +
                               "echo 'Не удалось определить менеджер пакетов'";
            
            executeCommand(jschSession, installCmd)
                .onSuccess(output -> {
                    if (output.contains("Не удалось определить менеджер пакетов")) {
                        sendCopyProgress(userId, taskId, "Установка инструментов", "error", 0);
                        logger.error("Failed to install tools: Package manager not found");
                    } else {
                        sendCopyProgress(userId, taskId, "Установка инструментов", "done", 100);
                    }
                })
                .onFailure(err -> {
                    sendCopyProgress(userId, taskId, "Установка инструментов", "error", 0);
                    logger.error("Failed to install tools: " + err.getMessage());
                });
        });
    }

    private Future<String> tryDirectCopy(String srcServerId, String destServerId, String srcPath, String destPath) {
        Session srcJsch = getAnyActiveJschSession(srcServerId);
        if (srcJsch == null) return Future.failedFuture("Source SSH session not active");

        JsonObject destServerConfig = serverConfigs.get(destServerId);
        if (destServerConfig == null) return Future.failedFuture("Destination server config not found");

        String destHost = destServerConfig.getString("host");
        String destUser = destServerConfig.getString("username");
        String destPass = destServerConfig.getString("password");
        int destPort = destServerConfig.getInteger("port", 22);

        // Используем sshpass для передачи пароля и scp для копирования
        // StrictHostKeyChecking=no и UserKnownHostsFile=/dev/null чтобы полностью игнорировать проверку ключей
        String scpCmd = String.format("sshpass -p %s scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -P %d -r %s %s@%s:%s",
                ShellUtils.sanitize(destPass),
                destPort,
                ShellUtils.sanitize(srcPath),
                destUser,
                destHost,
                ShellUtils.sanitize(destPath));

        return executeCommand(srcJsch, scpCmd);
    }

    private void performStreamingCopy(String srcServerId, String destServerId, String srcPath, String destPath, String userId, String taskId, Message<JsonObject> message) {
        vertx.executeBlocking(() -> {
            Session srcJsch = getAnyActiveJschSession(srcServerId);
            Session destJsch = getAnyActiveJschSession(destServerId);

            if (srcJsch == null || destJsch == null) {
                throw new RuntimeException("One of SSH sessions is not active");
            }

            com.jcraft.jsch.ChannelSftp sftpSrc = null;
            com.jcraft.jsch.ChannelSftp sftpDest = null;
            try {
                sftpSrc = (com.jcraft.jsch.ChannelSftp) srcJsch.openChannel("sftp");
                sftpSrc.connect();
                sftpDest = (com.jcraft.jsch.ChannelSftp) destJsch.openChannel("sftp");
                sftpDest.connect();

                long fileSize = 0;
                try {
                    fileSize = sftpSrc.stat(srcPath).getSize();
                } catch (Exception e) {
                    logger.warn("Could not get file size for progress: {}", e.getMessage());
                }

                final long finalSize = fileSize;
                SftpProgressMonitor monitor = new SftpProgressMonitor() {
                    private long transferred = 0;
                    private long lastUpdate = 0;

                    @Override
                    public void init(int op, String src, String dest, long max) {}

                    @Override
                    public boolean count(long count) {
                        transferred += count;
                        long now = System.currentTimeMillis();
                        if (now - lastUpdate > 500) { // Update every 500ms
                            int percent = finalSize > 0 ? (int) (transferred * 100 / finalSize) : 0;
                            sendCopyProgress(userId, taskId, srcPath, "copying", percent);
                            lastUpdate = now;
                        }
                        return true;
                    }

                    @Override
                    public void end() {
                        sendCopyProgress(userId, taskId, srcPath, "done", 100);
                    }
                };

                java.io.InputStream is = sftpSrc.get(srcPath);
                sftpDest.put(is, destPath, monitor);
                return null;
            } catch (Exception e) {
                sendCopyProgress(userId, taskId, srcPath, "error", 0);
                throw new RuntimeException("Remote copy failed: " + e.getMessage(), e);
            } finally {
                if (sftpSrc != null) sftpSrc.disconnect();
                if (sftpDest != null) sftpDest.disconnect();
            }
        }).onSuccess(v -> {
            message.reply(new JsonObject().put("status", "ok"));
            notifyFilesChanged(userId, destServerId, destPath);
        })
          .onFailure(err -> message.fail(500, err.getMessage()));
    }

    private void sendCopyProgress(String userId, String taskId, String srcPath, String status, int percent) {
        sendCopyProgress(userId, taskId, srcPath, status, percent, null);
    }

    private void sendCopyProgress(String userId, String taskId, String srcPath, String status, int percent, String error) {
        if (taskId == null) return;
        JsonObject progress = new JsonObject()
            .put("taskId", taskId)
            .put("srcPath", srcPath)
            .put("status", status)
            .put("percent", percent);
        if (error != null) {
            progress.put("error", error);
        }
        vertx.eventBus().publish(SSH_COMMAND_OUT_PREFIX + userId + FILES_COPY_PROGRESS, progress);
    }

    private Future<String> executeCommand(Session jschSession, String command) {
        return vertx.executeBlocking(() -> {
            ChannelExec channel = null;
            try {
                if (!jschSession.isConnected()) {
                    throw new RuntimeException("SSH session is not connected");
                }
                channel = (ChannelExec) jschSession.openChannel("exec");
                channel.setCommand(command);
                InputStream in = channel.getInputStream();
                InputStream err = channel.getErrStream();
                channel.connect(15000);

                byte[] responseBytes = in.readAllBytes();
                byte[] errorBytes = err.readAllBytes();

                long start = System.currentTimeMillis();
                while (!channel.isClosed() && System.currentTimeMillis() - start < 5000) {
                    Thread.sleep(50);
                }
                int exitStatus = channel.getExitStatus();

                if (exitStatus != 0 && exitStatus != -1) {
                    String errorMsg = new String(errorBytes, StandardCharsets.UTF_8).trim();
                    if (errorMsg.isEmpty()) errorMsg = "Exit status " + exitStatus;
                    throw new RuntimeException("Command failed: " + errorMsg);
                } else {
                    return new String(responseBytes, StandardCharsets.UTF_8);
                }
            } catch (Exception e) {
                if (e.getMessage() != null && e.getMessage().startsWith("Command failed:")) {
                    logger.warn("Command execution failed: {} -> {}", command, e.getMessage());
                } else {
                    logger.error("Command execution failed: {}", command, e);
                }
                throw (e instanceof RuntimeException) ? (RuntimeException) e : new RuntimeException(e);
            } finally {
                if (channel != null) {
                    channel.disconnect();
                }
            }
        });
    }

    private JsonArray parseLsOutput(String output) {
        JsonArray arr = new JsonArray();
        String[] lines = output.split("\n");
        for (String line : lines) {
            line = line.trim();
            if (line.startsWith("total") || line.isEmpty()) continue;
            String[] parts = line.split("\\s+", 8);
            if (parts.length < 8) continue;

            boolean isDir = parts[0].startsWith("d");
            String name = parts[7];
            if (".".equals(name) || "..".equals(name)) continue;

            arr.add(new JsonObject()
                .put("name", name)
                .put("isDir", isDir)
                .put("size", parts[4])
                .put("date", parts[5] + " " + parts[6])
                .put("perm", parts[0]));
        }
        return arr;
    }

    private JsonObject parseDfOutput(String output) {
        try {
            String[] lines = output.trim().split("\n");
            if (lines.length == 0) return null;
            String lastLine = lines[lines.length - 1].trim();
            String[] parts = lastLine.split("\\s+");
            
            int usePercentIdx = -1;
            for (int i = 0; i < parts.length; i++) {
                if (parts[i].endsWith("%")) {
                    usePercentIdx = i;
                    break;
                }
            }
            
            if (usePercentIdx >= 3) {
                return new JsonObject()
                    .put("size", parts[usePercentIdx - 3])
                    .put("used", parts[usePercentIdx - 2])
                    .put("avail", parts[usePercentIdx - 1])
                    .put("usePercent", parts[usePercentIdx]);
            }
        } catch (Exception e) {
            logger.warn("Failed to parse df output: {}", output);
        }
        return null;
    }

    private boolean checkSessionLimit(String userId, String serverId, boolean isDocker, Message<JsonObject> message) {
        JsonObject userCfg = userConfigs.get(userId);
        int maxSessions = userCfg != null ? userCfg.getInteger("maxSessionsPerServer", 100) : 100;

        long currentActive = sessions.values().stream()
            .filter(s -> userId.equals(s.userId) && serverId.equals(s.serverId) && s.isDocker == isDocker)
            .count();

        long currentRestorable = restorableSessions.values().stream()
            .filter(c -> userId.equals(c.getString(SESSION_USER_ID)) && serverId.equals(c.getString("serverId")))
            .filter(c -> {
                String cmd = c.getString("command");
                return isDockerCommand(cmd) == isDocker;
            })
            .filter(c -> !sessions.containsKey(c.getString("sessionId")))
            .count();

        if (currentActive + currentRestorable >= maxSessions) {
            String type = isDocker ? "докер-сессий" : "терминалов";
            logger.warn("User {} reached {} session limit for server {}: current={}, max={}, active={}, restorable={}", 
                userId, isDocker ? "docker" : "ssh", serverId, currentActive + currentRestorable, maxSessions, currentActive, currentRestorable);
            message.fail(403, "Превышен лимит открытых " + type + " для этого сервера (максимум: " + maxSessions + ")");
            return false;
        }
        return true;
    }

    private void checkIdleSessions() {
        long now = System.currentTimeMillis();
        sessions.forEach((sessionId, session) -> {
            if (now - session.lastActivity > IDLE_TIMEOUT_MS) {
                logger.info("Closing idle session due to timeout (3 min): {}", sessionId);
                if (sessions.remove(sessionId) != null) {
                    closeSshSession(session);
                    // Не удаляем из Redis, чтобы сессия была восстанавливаемой
                    notifySessionTerminated(session.userId, sessionId, false);
                }
            }
        });
    }

    private Future<Void> loadRestorableSessions() {
        Promise<Void> promise = Promise.promise();
        redis.send(Request.cmd(Command.KEYS).arg("ssh:session:*"))
            .onSuccess(response -> {
                if (response == null || response.size() == 0) {
                    promise.complete();
                    return;
                }
                List<Future<Void>> futures = new ArrayList<>();
                response.forEach(resKey -> {
                    String key = resKey.toString();
                    Promise<Void> getPromise = Promise.promise();
                    futures.add(getPromise.future());
                    redis.send(Request.cmd(Command.GET).arg(key))
                        .onSuccess(resData -> {
                            if (resData != null) {
                                try {
                                    JsonObject config = new JsonObject(resData.toString());
                                    String sessionId = config.getString("sessionId");
                                    if (sessionId != null) {
                                        if (config.getString("serverId") == null) {
                                            config.put("serverId", config.getString("id"));
                                        }
                                        restorableSessions.put(sessionId, config);
                                    }
                                } catch (Exception e) {
                                    logger.error("Failed to parse session config for key {}", key, e);
                                }
                            }
                            getPromise.complete();
                        })
                        .onFailure(err -> {
                            logger.error("Failed to get session metadata for key {}", key, err);
                            getPromise.complete();
                        });
                });
                Future.all(futures).onComplete(ar -> promise.complete());
            })
            .onFailure(err -> {
                logger.error("Failed to fetch session keys from Redis", err);
                promise.complete();
            });
        return promise.future();
    }

    private void saveSessionToRedis(JsonObject config) {
        String sessionId = config.getString("sessionId");
        String userId = config.getString("userId");
        String key = "ssh:session:" + sessionId;
        
        // Кэшируем в памяти для быстрого доступа
        restorableSessions.put(sessionId, config);
        
        redis.send(Request.cmd(Command.SET).arg(key).arg(config.encode()).arg("EX").arg("86400"))
            .onFailure(err -> logger.error("Failed to save session to Redis", err));

        // Добавляем в список порядка
        String orderKey = "ssh:user_order:" + userId;
        redis.send(Request.cmd(Command.RPUSH).arg(orderKey).arg(sessionId))
            .onFailure(err -> logger.error("Failed to add session to order in Redis", err));
    }

    private void removeSessionFromRedis(String userId, String sessionId) {
        String key = "ssh:session:" + sessionId;
        
        restorableSessions.remove(sessionId);
        
        redis.send(Request.cmd(Command.DEL).arg(key))
            .onFailure(err -> logger.error("Failed to remove session from Redis", err));

        if (userId != null) {
            String orderKey = "ssh:user_order:" + userId;
            redis.send(Request.cmd(Command.LREM).arg(orderKey).arg("0").arg(sessionId))
                .onFailure(err -> logger.error("Failed to remove session from order in Redis", err));
        }
    }

    private void sendProgress(String userId, String sessionId, String message) {
        vertx.eventBus().publish("ssh.out." + userId + ".ssh.session.progress", new JsonObject()
            .put("sessionId", sessionId)
            .put("message", message));
    }

    private String getServerId(String sessionId, String userId) {
        if (sessionId == null || userId == null) return null;
        SshSession s = sessions.get(sessionId);
        if (s != null && userId.equals(s.userId)) return s.serverId;
        JsonObject config = restorableSessions.get(sessionId);
        if (config != null && userId.equals(config.getString("userId"))) return config.getString("serverId");
        return null;
    }

    private Session getAnyActiveJschSession(String serverId) {
        if (serverId == null) return null;
        for (int i = 0; i < 100; i++) {
            String key = serverId + ":" + i;
            Session s = jschSessions.get(key);
            if (s != null && s.isConnected()) {
                return s;
            }
        }
        return null;
    }

    private void dispatchDockerRequest(String sessionId, String userId, String method, String path, String body, io.vertx.core.eventbus.Message<JsonObject> message) {
        String serverId = getServerId(sessionId, userId);
        if (serverId == null) {
            message.fail(403, "Доступ запрещен или сессия не найдена");
            return;
        }

        boolean cacheable = "GET".equalsIgnoreCase(method);
        String cacheKey = serverId + ":" + method + ":" + path + (body != null ? ":" + body : "");

        boolean isLogRequest = path.contains("/logs?");

        if (cacheable) {
            JsonObject cached = dockerCache.get(cacheKey);
            if (cached != null && System.currentTimeMillis() - cached.getLong("timestamp") < 3000) {
                logger.debug("Returning cached Docker API response for server {}: {} {}", serverId, method, path);
                replyWithDockerData(message, cached.getString("data"), !isLogRequest);
                return;
            }

            Future<String> pending = pendingDockerRequests.get(cacheKey);
            if (pending != null) {
                logger.debug("Collapsing Docker API request for server {}: {} {}", serverId, method, path);
                pending.onComplete(ar -> {
                    if (ar.succeeded()) {
                        replyWithDockerData(message, ar.result(), !isLogRequest);
                    } else {
                        message.fail(500, ar.cause().getMessage());
                    }
                });
                return;
            }
        }

        Session jschSession = getAnyActiveJschSession(serverId);
        if (jschSession == null) {
            message.fail(503, "Нет активного SSH-соединения с сервером. Пожалуйста, подключитесь или разбудите сессию.");
            return;
        }

        Promise<String> promise = Promise.promise();
        if (cacheable) {
            pendingDockerRequests.put(cacheKey, promise.future());
        }

        logger.debug("Executing Docker API request: {} {} on server {}", method, path, serverId);
        vertx.<byte[]>executeBlocking(() -> {
            if (!dockerApiSemaphore.tryAcquire(15, TimeUnit.SECONDS)) {
                throw new RuntimeException("Превышен лимит одновременных запросов к Docker API. Пожалуйста, подождите.");
            }
            try {
                if (!jschSession.isConnected()) {
                    throw new RuntimeException("SSH session is not connected");
                }
                ChannelExec channel = (ChannelExec) jschSession.openChannel("exec");
                String fullUrl = "http://localhost" + path;
                String command = String.format("curl -s --max-time 15 -X %s --unix-socket /var/run/docker.sock %s", 
                        ShellUtils.sanitize(method), ShellUtils.sanitize(fullUrl));
                channel.setCommand(command);
                InputStream in = channel.getInputStream();
                InputStream err = channel.getErrStream();
                channel.connect(10000);

                byte[] responseBytes = in.readAllBytes();
                byte[] errorBytes = err.readAllBytes();
                
                long start = System.currentTimeMillis();
                while (!channel.isClosed() && System.currentTimeMillis() - start < 2000) {
                    Thread.sleep(50);
                }
                int exitStatus = channel.getExitStatus();
                channel.disconnect();

                if (exitStatus != 0 && exitStatus != -1) {
                    String errorMsg = new String(errorBytes).trim();
                    if (errorMsg.isEmpty()) errorMsg = "Exit status " + exitStatus;
                    throw new RuntimeException("Docker API call failed: " + errorMsg);
                } else {
                    return responseBytes;
                }
            } catch (Exception e) {
                logger.error("Docker API request failed: {} {} on server {}", method, path, serverId, e);
                throw (e instanceof RuntimeException) ? (RuntimeException) e : new RuntimeException(e);
            } finally {
                dockerApiSemaphore.release();
            }
        }).onComplete(res -> {
            if (res.succeeded()) {
                byte[] bytes = res.result();
                String processed = isLogRequest ? processDockerLogs(bytes) : new String(bytes, StandardCharsets.UTF_8);

                if (cacheable) {
                    pendingDockerRequests.remove(cacheKey);
                    dockerCache.put(cacheKey, new JsonObject().put("data", processed).put("timestamp", System.currentTimeMillis()));
                    promise.complete(processed);
                }
                replyWithDockerData(message, processed, !isLogRequest);
            } else {
                if (cacheable) pendingDockerRequests.remove(cacheKey);
                promise.fail(res.cause());
                message.fail(500, res.cause().getMessage());
            }
        });
    }

    private String processDockerLogs(byte[] raw) {
        if (raw == null || raw.length < 8) return raw != null ? new String(raw, StandardCharsets.UTF_8) : "";
        
        // Docker multiplexed stream header: [8]byte{type, 0, 0, 0, size1, size2, size3, size4}
        if (raw[1] != 0 || raw[2] != 0 || raw[3] != 0) {
            return new String(raw, StandardCharsets.UTF_8);
        }

        try (java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream()) {
            int i = 0;
            while (i + 8 <= raw.length) {
                int size = 0;
                for (int j = 0; j < 4; j++) {
                    size = (size << 8) | (raw[i + 4 + j] & 0xFF);
                }
                i += 8;
                if (i + size <= raw.length) {
                    out.write(raw, i, size);
                    i += size;
                } else {
                    out.write(raw, i, raw.length - i);
                    break;
                }
            }
            return out.toString(StandardCharsets.UTF_8.name());
        } catch (Exception e) {
            return new String(raw, StandardCharsets.UTF_8);
        }
    }

    private void replyWithDockerData(io.vertx.core.eventbus.Message<JsonObject> message, String result, boolean isJson) {
        if (result == null) {
            message.reply(new JsonObject().put("status", "ok").put("data", isJson ? new JsonObject() : ""));
            return;
        }

        if (!isJson) {
            message.reply(new JsonObject().put("status", "ok").put("data", result));
            return;
        }

        try {
            String trimmed = result.trim();
            if (trimmed.startsWith("[")) {
                message.reply(new JsonObject().put("status", "ok").put("data", new JsonArray(trimmed)));
            } else if (trimmed.startsWith("{")) {
                message.reply(new JsonObject().put("status", "ok").put("data", new JsonObject(trimmed)));
            } else {
                message.reply(new JsonObject().put("status", "ok").put("data", result));
            }
        } catch (Exception e) {
            message.reply(new JsonObject().put("status", "ok").put("data", result));
        }
    }

    private void notifySessionCreated(String userId, String sessionId, String serverId, String name, boolean isDocker, String viewMode) {
        vertx.eventBus().publish("ssh.out." + userId + ".ssh.session.created", new JsonObject()
            .put("sessionId", sessionId)
            .put("serverId", serverId)
            .put("name", name)
            .put("isDocker", isDocker)
            .put("viewMode", viewMode)
            .put("serverName", serverConfigs.containsKey(serverId) ? serverConfigs.get(serverId).getString("name") : serverId));
    }

    private void notifySessionTerminated(String userId, String sessionId, boolean byUser) {
        vertx.eventBus().publish("ssh.out." + userId + ".ssh.session.terminated", new JsonObject()
            .put("sessionId", sessionId)
            .put("byUser", byUser));
    }

    private void terminateChildDockerSessions(String userId, String serverId, String parentSessionId) {
        sessions.values().forEach(s -> {
            if (userId.equals(s.userId) && serverId.equals(s.serverId) && s.isDocker && !s.sessionId.equals(parentSessionId)) {
                if (sessions.remove(s.sessionId) != null) {
                    closeSshSession(s);
                    removeSessionFromRedis(userId, s.sessionId);
                    notifySessionTerminated(userId, s.sessionId, true);
                    logger.info("Child docker session terminated (cascade): {}", s.sessionId);
                }
            }
        });

        restorableSessions.forEach((sid, config) -> {
            if (userId.equals(config.getString("userId")) && serverId.equals(config.getString("serverId")) && !sid.equals(parentSessionId)) {
                String cmd = config.getString("command", "");
                boolean isDocker = config.getBoolean("isDocker", cmd != null && cmd.startsWith("docker exec"));
                if (isDocker) {
                    if (restorableSessions.remove(sid) != null) {
                        removeSessionFromRedis(userId, sid);
                        notifySessionTerminated(userId, sid, true);
                        logger.info("Child restorable docker session removed (cascade): {}", sid);
                    }
                }
            }
        });
    }

    private boolean hasDockerView(String userId, String serverId) {
        boolean active = sessions.values().stream()
            .anyMatch(s -> userId.equals(s.userId) && serverId.equals(s.serverId) && "docker".equals(s.viewMode));
        if (active) return true;

        return restorableSessions.values().stream()
            .anyMatch(c -> userId.equals(c.getString("userId")) && serverId.equals(c.getString("serverId")) && "docker".equals(c.getString("viewMode")));
    }

    private Future<Void> connectSsh(JsonObject config, String sessionId, String serverId, String userId) {
        String viewMode = config.getString("viewMode", "terminal");
        String command = config.getString("command");
        boolean isDocker = command != null && command.startsWith("docker exec");
        logger.info("connectSsh started: sessionId={}, serverId={}, userId={}, viewMode={}", sessionId, serverId, userId, viewMode);
        return vertx.executeBlocking(() -> {
            try {
                Session jschSession = null;
                String jschSessionKey = null;
                synchronized (jschSessions) {
                    logger.debug("Finding/creating jschSession for server: {}", serverId);
                    // Ищем существующую сессию с доступными слотами для каналов (обычно лимит 10)
                    for (int i = 0; i < 100; i++) {
                        String candidateKey = serverId + ":" + i;
                        Session existing = jschSessions.get(candidateKey);
                        if (existing != null && existing.isConnected()) {
                            int refs = sessionReferences.getOrDefault(candidateKey, 0);
                            if (refs < MAX_CHANNELS_PER_SESSION) {
                                jschSession = existing;
                                jschSessionKey = candidateKey;
                                sessionReferences.put(jschSessionKey, refs + 1);
                                logger.info("Reusing existing SSH session {} for server: {} (channels: {})", jschSessionKey, serverId, refs + 1);
                                break;
                            }
                        } else if (existing == null) {
                            jschSessionKey = candidateKey;
                            break;
                        }
                    }

                    if (jschSession == null) {
                        logger.info("Establishing new SSH connection for server {} (key: {})", serverId, jschSessionKey);
                        sendProgress(userId, sessionId, "Инициализация нового подключения...");
                        JSch jsch = new JSch();
                        String host = config.getString("host");
                        int port = config.getInteger("port", 22);
                        String user = config.getString("user");
                        String password = config.getString("password");

                        sendProgress(userId, sessionId, "Создание сессии для " + host + "...");
                        jschSession = jsch.getSession(user, host, port);
                        jschSession.setPassword(password);

                        Properties prop = new Properties();
                        prop.put("StrictHostKeyChecking", "no");
                        jschSession.setConfig(prop);

                        sendProgress(userId, sessionId, "Подключение к серверу...");
                        logger.info("Connecting to {}:{}...", host, port);
                        jschSession.connect(30000);

                        jschSessions.put(jschSessionKey, jschSession);
                        sessionReferences.put(jschSessionKey, 1);
                        logger.info("New SSH connection established: {}@{}:{} (key: {})", user, host, port, jschSessionKey);
                    }
                }

                logger.debug("Opening SSH channel: sessionId={}", sessionId);
                sendProgress(userId, sessionId, "Открытие канала...");
                Channel channel;
                if (command != null && !command.isEmpty()) {
                    ChannelExec channelExec = (ChannelExec) jschSession.openChannel("exec");
                    channelExec.setCommand(command);
                    channelExec.setPty(true);
                    channelExec.setPtyType("xterm-256color");
                    channelExec.setEnv("TERM", "xterm-256color");
                    channel = channelExec;
                } else {
                    ChannelShell channelShell = (ChannelShell) jschSession.openChannel("shell");
                    channelShell.setPtyType("xterm-256color");
                    channelShell.setEnv("TERM", "xterm-256color");
                    channel = channelShell;
                }

                final String finalJschSessionKey = jschSessionKey;
                String name = config.getString("name", serverConfigs.containsKey(serverId) ? serverConfigs.get(serverId).getString("name") : serverId);
                SshSession sshSession = new SshSession(sessionId, serverId, userId, jschSession, channel, finalJschSessionKey, viewMode, isDocker, name);

                // Настройка вывода данных из SSH без блокировки рабочих потоков Vert.x
                java.io.OutputStream sshOut = new java.io.OutputStream() {
                    @Override
                    public void write(int b) {
                        write(new byte[]{(byte) b}, 0, 1);
                    }

                    @Override
                    public void write(byte[] b, int off, int len) {
                        sshSession.lastActivity = System.currentTimeMillis();
                        String data = sshSession.appendOutput(b, off, len);
                        vertx.eventBus().publish(SSH_COMMAND_OUT_PREFIX + userId + SSH_COMMAND_OUT_SUFFIX, new JsonObject()
                            .put("sessionId", sessionId)
                            .put("data", data));
                    }

                    @Override
                    public void close() {
                        logger.info("SSH channel closed: sessionId={}", sessionId);
                        if (sessions.remove(sessionId) != null) {
                            closeSshSession(sshSession);
                            // Не удаляем из Redis, чтобы сессия была восстанавливаемой
                            notifySessionTerminated(sshSession.userId, sessionId, false);
                        }
                    }
                };

                channel.setOutputStream(sshOut);
                channel.setExtOutputStream(sshOut);

                try {
                    logger.info("Connecting SSH channel: sessionId={}", sessionId);
                    channel.connect(30000);
                    sessions.put(sessionId, sshSession);
                    sendProgress(userId, sessionId, "Готово");
                    logger.info("SSH session ready: sessionId={}", sessionId);
                } catch (Exception e) {
                    logger.error("Failed to connect SSH channel: sessionId={}", sessionId, e);
                    sessions.remove(sessionId);
                    closeSshSession(sshSession);
                    throw e;
                }

                return null;
            } catch (Exception e) {
                logger.error("connectSsh failed: sessionId={}", sessionId, e);
                throw new RuntimeException(e);
            }
        });
    }

    private void saveViewModeToRedis(String sessionId, String viewMode) {
        String key = "ssh:session:" + sessionId;
        redis.send(Request.cmd(Command.GET).arg(key)).onSuccess(res -> {
            if (res != null) {
                try {
                    JsonObject config = new JsonObject(res.toString());
                    config.put("viewMode", viewMode);
                    redis.send(Request.cmd(Command.SET).arg(key).arg(config.encode()).arg("EX").arg("86400"));
                } catch (Exception e) {
                    logger.error("Failed to update viewMode in Redis for session {}", sessionId, e);
                }
            }
        });
    }

    private void closeSshSession(SshSession sshSession) {
        try {
            if (sshSession.channel != null) {
                sshSession.channel.disconnect();
            }
            synchronized (jschSessions) {
                String key = sshSession.jschSessionKey;
                Integer refs = sessionReferences.get(key);
                if (refs != null) {
                    refs--;
                    if (refs <= 0) {
                        sessionReferences.remove(key);
                        Session jschSession = jschSessions.remove(key);
                        if (jschSession != null && jschSession.isConnected()) {
                            jschSession.disconnect();
                            logger.info("Closed shared SSH session {} for server: {}", key, sshSession.serverId);
                        }
                    } else {
                        sessionReferences.put(key, refs);
                        logger.info("Decremented refs for session: {}, remaining: {}", key, refs);
                    }
                }
            }
        } catch (Exception e) {
            logger.error("Error closing SSH session {}", sshSession.sessionId, e);
        }
    }

    private boolean isDockerCommand(String command) {
        return command != null && command.startsWith("docker exec");
    }

    private void notifyFilesChanged(String userId, String serverId, String path) {
        if (path == null || userId == null || serverId == null) return;
        String parentPath = getParentPath(path);
        vertx.eventBus().publish(SSH_COMMAND_OUT_PREFIX + userId + FILES_CHANGED, new JsonObject()
            .put("serverId", serverId)
            .put("path", parentPath));
    }

    private String getParentPath(String path) {
        if (path == null || path.equals("/") || path.equals(".")) return path;
        String p = path;
        if (p.endsWith("/")) p = p.substring(0, p.length() - 1);
        int lastSlash = p.lastIndexOf('/');
        if (lastSlash == -1) return ".";
        if (lastSlash == 0) return "/";
        return p.substring(0, lastSlash);
    }

    private static class SshSession {
        final String sessionId;
        final String serverId;
        final String userId;
        final String name;
        final Session session;
        final Channel channel;
        final String jschSessionKey;
        final OutputStream out;
        final boolean isDocker;
        volatile long lastActivity;
        volatile String viewMode = "terminal";
        private final StringBuilder outputBuffer = new StringBuilder();
        private static final int MAX_BUFFER_SIZE = 100 * 1024; // 100 KB
        private final java.nio.charset.CharsetDecoder decoder = java.nio.charset.StandardCharsets.UTF_8.newDecoder()
            .onMalformedInput(java.nio.charset.CodingErrorAction.REPLACE)
            .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPLACE);
        private final java.nio.ByteBuffer byteBuffer = java.nio.ByteBuffer.allocate(8192);
        private final java.nio.CharBuffer charBuffer = java.nio.CharBuffer.allocate(8192);

        SshSession(String sessionId, String serverId, String userId, Session session, Channel channel, String jschSessionKey, boolean isDocker, String name) throws Exception {
            this.sessionId = sessionId;
            this.serverId = serverId;
            this.userId = userId;
            this.name = name;
            this.session = session;
            this.channel = channel;
            this.jschSessionKey = jschSessionKey;
            this.isDocker = isDocker;
            this.out = channel.getOutputStream();
            this.lastActivity = System.currentTimeMillis();
        }

        SshSession(String sessionId, String serverId, String userId, Session session, Channel channel, String jschSessionKey, String viewMode, boolean isDocker, String name) throws Exception {
            this(sessionId, serverId, userId, session, channel, jschSessionKey, isDocker, name);
            if (viewMode != null) {
                this.viewMode = viewMode;
            }
        }

        synchronized String appendOutput(byte[] b, int off, int len) {
            if (byteBuffer.remaining() < len) {
                // Если буфер мал, обрабатываем то что есть
                decodeAndAppend(false);
            }
            if (len > byteBuffer.capacity()) {
                // Если входящие данные больше буфера, обрабатываем их напрямую частями (упростим для примера)
                byteBuffer.put(b, off, byteBuffer.remaining());
                decodeAndAppend(false);
            }
            byteBuffer.put(b, off, len);
            return decodeAndAppend(false);
        }

        private String decodeAndAppend(boolean endOfInput) {
            byteBuffer.flip();
            java.nio.charset.CoderResult result = decoder.decode(byteBuffer, charBuffer, endOfInput);
            charBuffer.flip();
            String decoded = charBuffer.toString();
            outputBuffer.append(decoded);
            charBuffer.clear();
            byteBuffer.compact();

            if (outputBuffer.length() > MAX_BUFFER_SIZE) {
                outputBuffer.delete(0, outputBuffer.length() - MAX_BUFFER_SIZE);
            }
            return decoded;
        }

        synchronized String getOutputHistory() {
            return outputBuffer.toString();
        }

        void write(String data) {
            this.lastActivity = System.currentTimeMillis();
            try {
                out.write(data.getBytes(StandardCharsets.UTF_8));
                out.flush();
            } catch (Exception e) {
                logger.error("Error writing to SSH session {}", sessionId, e);
            }
        }
    }
}
