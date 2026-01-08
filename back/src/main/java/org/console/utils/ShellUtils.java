package org.console.utils;

import java.util.regex.Pattern;

public class ShellUtils {
    private static final Pattern SAFE_PATTERN = Pattern.compile("^[a-zA-Z0-9._/-]+$");

    public static String sanitize(String arg) {
        if (arg == null) return "''";
        return "'" + arg.replace("'", "'\\''") + "'";
    }

    public static boolean isSafePath(String path) {
        if (path == null) return false;
        // Basic check for common path manipulation
        if (path.contains("..")) return false;
        return SAFE_PATTERN.matcher(path).matches();
    }
    
    public static boolean isValidContainerId(String id) {
        if (id == null) return false;
        return id.matches("^[a-zA-Z0-9_-]+$");
    }
}
