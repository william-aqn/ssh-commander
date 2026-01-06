package org.console.utils;

import io.vertx.core.json.JsonArray;
import io.vertx.core.json.JsonObject;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

public class ConfigUtils {
    private static final Logger logger = LoggerFactory.getLogger(ConfigUtils.class);
    private static final Map<String, JsonArray> cache = new ConcurrentHashMap<>();

    public static Map<String, JsonObject> loadJsonMap(String fileName, String keyField) {
        JsonArray array = cache.computeIfAbsent(fileName, name -> {
            try (InputStream is = ConfigUtils.class.getClassLoader().getResourceAsStream(name)) {
                if (is == null) {
                    logger.error("{} not found in resources", name);
                    return new JsonArray();
                }
                byte[] bytes = is.readAllBytes();
                JsonArray arr = new JsonArray(new String(bytes, StandardCharsets.UTF_8));
                logger.info("Loaded {} items from {}", arr.size(), name);
                return arr;
            } catch (Exception e) {
                logger.error("Failed to load {}", name, e);
                return new JsonArray();
            }
        });

        Map<String, JsonObject> map = new HashMap<>();
        for (int i = 0; i < array.size(); i++) {
            JsonObject obj = array.getJsonObject(i);
            String key = obj.getString(keyField);
            if (key != null) {
                map.put(key, obj);
            }
        }
        return map;
    }
}
