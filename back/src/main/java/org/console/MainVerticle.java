package org.console;

import com.jcraft.jsch.ChannelExec;
import com.jcraft.jsch.ChannelSftp;
import com.jcraft.jsch.JSch;
import com.jcraft.jsch.Session;
import io.vertx.core.AbstractVerticle;
import io.vertx.core.Promise;
import io.vertx.core.http.HttpServerResponse;
import io.vertx.core.json.JsonObject;
import io.vertx.ext.bridge.BridgeEventType;
import io.vertx.ext.bridge.PermittedOptions;
import io.vertx.ext.web.Router;
import io.vertx.ext.web.RoutingContext;
import io.vertx.ext.web.handler.BodyHandler;
import io.vertx.ext.web.handler.SessionHandler;
import io.vertx.ext.web.handler.sockjs.SockJSBridgeOptions;
import io.vertx.ext.web.handler.sockjs.SockJSHandler;
import io.vertx.ext.web.sstore.redis.RedisSessionStore;
import io.vertx.redis.client.Command;
import io.vertx.redis.client.Redis;
import io.vertx.redis.client.RedisOptions;
import io.vertx.redis.client.Request;
import org.console.utils.ConfigUtils;
import org.console.utils.ShellUtils;
import org.mindrot.jbcrypt.BCrypt;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;
import java.util.Properties;

import static org.console.Constants.*;

public class MainVerticle extends AbstractVerticle {
    private static final Logger logger = LoggerFactory.getLogger(MainVerticle.class);
    private Redis redis;
    private Map<String, JsonObject> users;

    @Override
    public void start(Promise<Void> startPromise) {
        // Загрузка конфигураций
        Map<String, JsonObject> userConfigs = ConfigUtils.loadJsonMap("users.json", "id");
        Map<String, JsonObject> serverConfigs = ConfigUtils.loadJsonMap("servers.json", "id");

        // Индексация пользователей для логина (по имени)
        users = new HashMap<>();
        userConfigs.values().forEach(u -> users.put(u.getString("username"), u));

        // Redis Client
        String redisHost = System.getenv().getOrDefault("REDIS_HOST", "localhost");
        String redisPort = System.getenv().getOrDefault("REDIS_PORT", "6379");
        redis = Redis.createClient(vertx, new RedisOptions().setConnectionString("redis://" + redisHost + ":" + redisPort));

        Router router = Router.router(vertx);

        // Session handling
        router.route().handler(SessionHandler.create(RedisSessionStore.create(vertx, redis)));
        router.route().handler(BodyHandler.create());

        router.post("/api/login").handler(this::handleLogin);
        router.get("/api/user").handler(this::handleGetUser);
        router.post("/api/logout").handler(this::handleLogout);
        router.get("/api/download").handler(this::handleDownload);
        router.post("/api/upload").handler(this::handleUpload);

        // Настройка SockJS Bridge
        SockJSBridgeOptions options = new SockJSBridgeOptions()
            .addInboundPermitted(new PermittedOptions().setAddressRegex(SSH_COMMAND_IN.replace(".", "\\.") + ".*"))
            .addInboundPermitted(new PermittedOptions().setAddressRegex(SSH_SESSION_PREFIX.replace(".", "\\.") + ".*"))
            .addInboundPermitted(new PermittedOptions().setAddressRegex(SSH_SERVERS_NOTIFY_PREFIX.replace(".", "\\.") + ".*"))
            .addInboundPermitted(new PermittedOptions().setAddressRegex(DOCKER_PREFIX.replace(".", "\\.") + ".*"))
            .addInboundPermitted(new PermittedOptions().setAddressRegex(FILES_PREFIX.replace(".", "\\.") + ".*"))
            .addOutboundPermitted(new PermittedOptions().setAddressRegex(SSH_COMMAND_OUT_PREFIX.replace(".", "\\.") + ".*"));

        router.route("/eventbus/*").subRouter(SockJSHandler.create(vertx).bridge(options, this::handleBridgeEvent));

        // Развертывание SshVerticle
        vertx.deployVerticle(new SshVerticle(redis, serverConfigs, userConfigs))
            .onSuccess(id -> {
                logger.info("SshVerticle deployed");
                startHttpServer(router, startPromise);
            })
            .onFailure(err -> {
                logger.error("Failed to deploy SshVerticle", err);
                startPromise.fail(err);
            });
    }

    private void handleLogin(RoutingContext ctx) {
        JsonObject body;
        try {
            body = ctx.body().asJsonObject();
        } catch (Exception e) {
            jsonResponse(ctx, 400, new JsonObject().put("status", "error").put("message", "Invalid JSON"));
            return;
        }

        if (body == null) {
            jsonResponse(ctx, 400, new JsonObject().put("status", "error").put("message", "Missing body"));
            return;
        }

        String username = body.getString("username");
        String password = body.getString("password");

        JsonObject user = users.get(username);
        if (user != null && password != null && BCrypt.checkpw(password, user.getString("password"))) {
            String userId = user.getString("id");
            ctx.session().put(SESSION_USER_ID, userId);
            ctx.session().put(SESSION_USERNAME, username);
            jsonResponse(ctx, 200, new JsonObject().put("status", "ok").put("username", username).put("userId", userId));
        } else {
            jsonResponse(ctx, 401, new JsonObject().put("status", "error").put("message", "Invalid credentials"));
        }
    }

    private void handleGetUser(RoutingContext ctx) {
        String username = ctx.session().get(SESSION_USERNAME);
        String userId = ctx.session().get(SESSION_USER_ID);
        if (username != null && userId != null) {
            jsonResponse(ctx, 200, new JsonObject().put("status", "ok").put("username", username).put("userId", userId));
        } else {
            jsonResponse(ctx, 401, new JsonObject().put("status", "error"));
        }
    }

    private void handleLogout(RoutingContext ctx) {
        ctx.session().destroy();
        jsonResponse(ctx, 200, new JsonObject().put("status", "ok"));
    }

    private void handleDownload(RoutingContext ctx) {
        String userId = ctx.session().get(SESSION_USER_ID);
        if (userId == null) {
            ctx.response().setStatusCode(401).end("Unauthorized");
            return;
        }

        String sessionId = ctx.request().getParam("sessionId");
        String path = ctx.request().getParam("path");

        if (sessionId == null || path == null || path.contains("..")) {
            ctx.response().setStatusCode(400).end("Invalid parameters");
            return;
        }

        redis.send(Request.cmd(Command.GET).arg("ssh:session:" + sessionId))
            .onSuccess(res -> {
                if (res == null) {
                    ctx.response().setStatusCode(404).end("Session not found");
                    return;
                }
                JsonObject config = new JsonObject(res.toString());
                if (!userId.equals(config.getString(SESSION_USER_ID))) {
                    ctx.response().setStatusCode(403).end("Forbidden");
                    return;
                }

                streamFileFromSsh(ctx, config, path);
            })
            .onFailure(err -> ctx.response().setStatusCode(500).end(err.getMessage()));
    }

    private void streamFileFromSsh(RoutingContext ctx, JsonObject config, String path) {
        vertx.executeBlocking(() -> {
            Session jschSession = null;
            ChannelExec channel = null;
            try {
                JSch jsch = new JSch();
                jschSession = jsch.getSession(config.getString("user"), config.getString("host"), config.getInteger("port", 22));
                jschSession.setPassword(config.getString("password"));
                Properties prop = new Properties();
                prop.put("StrictHostKeyChecking", "no");
                jschSession.setConfig(prop);
                jschSession.connect(15000);

                channel = (ChannelExec) jschSession.openChannel("exec");
                String filename = path.contains("/") ? path.substring(path.lastIndexOf('/') + 1) : path;
                if (filename.isEmpty()) filename = "download";

                channel.setCommand("cat " + ShellUtils.sanitize(path));
                InputStream in = channel.getInputStream();
                channel.connect(15000);

                HttpServerResponse response = ctx.response();
                response.setChunked(true);
                response.putHeader("Content-Disposition", "attachment; filename=\"" + filename + "\"");
                response.putHeader("Content-Type", "application/octet-stream");

                byte[] buffer = new byte[8192];
                int read;
                while ((read = in.read(buffer)) != -1) {
                    response.write(io.vertx.core.buffer.Buffer.buffer(java.util.Arrays.copyOf(buffer, read)));
                }
                response.end();
                return null;
            } catch (Exception e) {
                logger.error("Download failed", e);
                if (!ctx.response().ended()) {
                    ctx.response().setStatusCode(500).end(e.getMessage());
                }
                return null;
            } finally {
                if (channel != null) channel.disconnect();
                if (jschSession != null) jschSession.disconnect();
            }
        });
    }

    private void handleBridgeEvent(io.vertx.ext.web.handler.sockjs.BridgeEvent event) {
        try {
            if (event.type() == BridgeEventType.SOCKET_CREATED) {
                logger.debug("Socket created: {}", (event.socket() != null ? event.socket().remoteAddress() : "unknown"));
                event.tryComplete(true);
                return;
            }

            if (event.type() == BridgeEventType.REGISTER) {
                String userId = (event.socket() != null && event.socket().webSession() != null) ? event.socket().webSession().get(SESSION_USER_ID) : null;
                if (userId != null) {
                    String address = event.getRawMessage().getString("address");
                    if (address != null && address.startsWith(SSH_COMMAND_OUT_PREFIX) && !address.startsWith(SSH_COMMAND_OUT_PREFIX + userId + ".")) {
                        logger.warn("User {} tried to subscribe to unauthorized address: {}", userId, address);
                        event.tryComplete(false);
                        return;
                    }
                }
            }

            if (event.type() == BridgeEventType.SEND || event.type() == BridgeEventType.PUBLISH) {
                io.vertx.ext.web.Session session = (event.socket() != null) ? event.socket().webSession() : null;
                String userId = (session != null) ? session.get(SESSION_USER_ID) : null;
                
                JsonObject rawMessage = event.getRawMessage();
                String address = rawMessage != null ? rawMessage.getString("address") : null;
                
                if (SSH_SESSION_RESTORE.equals(address)) {
                    logger.info("Bridge event: type={}, address={}, userId={}", event.type(), address, userId);
                } else if (logger.isDebugEnabled()) {
                    logger.debug("Bridge event: type={}, address={}, userId={}", event.type(), address, userId);
                }

                if (userId != null) {
                    if (rawMessage != null) {
                        JsonObject modifiableMessage = rawMessage.copy();

                        // Синхронизация виджета между вкладками пользователя
                        if (event.type() == BridgeEventType.PUBLISH && SSH_SESSION_WIDGET_LAYOUT.equals(address)) {
                            vertx.eventBus().publish(SSH_COMMAND_OUT_PREFIX + userId + ".ssh.widget.layout", modifiableMessage.getJsonObject("body"));
                        }

                        // Синхронизация режима отображения (terminal/docker) между вкладками пользователя
                        if (event.type() == BridgeEventType.PUBLISH && SSH_SESSION_VIEWMODE_SYNC.equals(address)) {
                            vertx.eventBus().publish(SSH_COMMAND_OUT_PREFIX + userId + ".ssh.viewmode.sync", modifiableMessage.getJsonObject("body"));
                        }

                        JsonObject body = modifiableMessage.getJsonObject("body");
                        if (body == null) {
                            body = new JsonObject();
                            modifiableMessage.put("body", body);
                        }
                        body.put(SESSION_USER_ID, userId);
                        event.setRawMessage(modifiableMessage);
                    }
                }
            }
        } catch (Exception e) {
            logger.error("Error in bridge event handler", e);
        } finally {
            event.tryComplete(true);
        }
    }

    private void handleUpload(RoutingContext ctx) {
        String userId = ctx.session().get(SESSION_USER_ID);
        if (userId == null) {
            ctx.response().setStatusCode(401).end("Unauthorized");
            return;
        }

        String sessionId = ctx.request().getParam("sessionId");
        String path = ctx.request().getParam("path");

        if (sessionId == null || path == null) {
            ctx.response().setStatusCode(400).end("Missing parameters");
            return;
        }

        redis.send(Request.cmd(Command.GET).arg("ssh:session:" + sessionId))
            .onSuccess(res -> {
                if (res == null) {
                    ctx.response().setStatusCode(404).end("Session not found");
                    return;
                }
                JsonObject config = new JsonObject(res.toString());
                if (!userId.equals(config.getString(SESSION_USER_ID))) {
                    ctx.response().setStatusCode(403).end("Forbidden");
                    return;
                }

                uploadFilesToSsh(ctx, config, path);
            })
            .onFailure(err -> ctx.response().setStatusCode(500).end(err.getMessage()));
    }

    private void uploadFilesToSsh(RoutingContext ctx, JsonObject config, String remotePath) {
        vertx.executeBlocking(() -> {
            Session jschSession = null;
            ChannelSftp sftp = null;
            try {
                JSch jsch = new JSch();
                jschSession = jsch.getSession(config.getString("user"), config.getString("host"), config.getInteger("port", 22));
                jschSession.setPassword(config.getString("password"));
                Properties prop = new Properties();
                prop.put("StrictHostKeyChecking", "no");
                jschSession.setConfig(prop);
                jschSession.connect(15000);

                sftp = (ChannelSftp) jschSession.openChannel("sftp");
                sftp.connect(15000);

                try {
                    sftp.cd(remotePath);
                } catch (Exception e) {
                    logger.warn("Could not cd to {}, attempting to use absolute paths if provided", remotePath);
                }

                for (io.vertx.ext.web.FileUpload fileUpload : ctx.fileUploads()) {
                    sftp.put(fileUpload.uploadedFileName(), fileUpload.fileName());
                }

                ctx.response().setStatusCode(200).end(new JsonObject().put("status", "ok").encode());
                
                // Оповещаем об изменении файлов в директории
                String userId = config.getString(SESSION_USER_ID);
                String serverId = config.getString("serverId");
                vertx.eventBus().publish(SSH_COMMAND_OUT_PREFIX + userId + FILES_CHANGED, new JsonObject()
                    .put("serverId", serverId)
                    .put("path", remotePath));
                return null;
            } catch (Exception e) {
                logger.error("Upload failed", e);
                if (!ctx.response().ended()) {
                    ctx.response().setStatusCode(500).end(e.getMessage());
                }
                return null;
            } finally {
                if (sftp != null) sftp.disconnect();
                if (jschSession != null) jschSession.disconnect();
            }
        });
    }

    private void jsonResponse(RoutingContext ctx, int statusCode, JsonObject payload) {
        ctx.response().setStatusCode(statusCode)
            .putHeader("Content-Type", "application/json")
            .end(payload.encode());
    }

    private void startHttpServer(Router router, Promise<Void> startPromise) {
        int port = Integer.parseInt(System.getenv().getOrDefault("HTTP_PORT", String.valueOf(DEFAULT_HTTP_PORT)));
        vertx.createHttpServer()
            .requestHandler(router)
            .listen(port)
            .onSuccess(server -> {
                logger.info("HTTP server started on port {}", port);
                startPromise.complete();
            })
            .onFailure(err -> {
                logger.error("Failed to start HTTP server", err);
                startPromise.fail(err);
            });
    }
}
