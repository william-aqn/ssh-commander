package org.console;

public class Constants {
    // EventBus Addresses
    public static final String SSH_COMMAND_IN = "ssh.command.in";
    public static final String SSH_SESSION_PREFIX = "ssh.session.";
    public static final String SSH_COMMAND_OUT_PREFIX = "ssh.out.";
    public static final String SSH_COMMAND_OUT_SUFFIX = ".ssh.command.out";
    
    public static final String SSH_SESSION_CREATE = "ssh.session.create";
    public static final String SSH_SESSION_RESTORE = "ssh.session.restore";
    public static final String SSH_SESSION_TERMINATE = "ssh.session.terminate";
    public static final String SSH_SESSION_VIEWMODE_SET = "ssh.session.viewmode.set";
    public static final String SSH_SESSION_VIEWMODE_SYNC = "ssh.session.viewmode.sync";
    public static final String SSH_SESSION_WIDGET_LAYOUT = "ssh.session.widget.layout";
    
    public static final String SSH_SERVERS_LIST = "ssh.servers.list";
    public static final String SSH_SERVERS_NOTIFY_PREFIX = "ssh.servers.";
    
    public static final String SSH_SESSION_KEEPALIVE = "ssh.session.keepalive";
    public static final String SSH_SESSION_HISTORY = "ssh.session.history";
    public static final String SSH_SESSION_REORDER = "ssh.session.reorder";
    public static final String SSH_SESSION_LIST = "ssh.session.list";
    public static final String SSH_SESSION_REORDERED_SUFFIX = ".ssh.session.reordered";

    public static final String DOCKER_PREFIX = "docker.";
    public static final String DOCKER_CONTAINERS_LIST = "docker.containers.list";
    public static final String DOCKER_CONTAINER_STATS = "docker.container.stats";
    public static final String DOCKER_CONTAINER_RESTART = "docker.container.restart";
    public static final String DOCKER_CONTAINER_LOGS = "docker.container.logs";

    public static final String FILES_PREFIX = "files.";
    public static final String FILES_LIST = "files.list";
    public static final String FILES_ARCHIVE = "files.archive";
    public static final String FILES_SIZE = "files.size";
    public static final String FILES_MKDIR = "files.mkdir";
    public static final String FILES_DELETE = "files.delete";
    public static final String FILES_CHMOD = "files.chmod";

    // Session attributes
    public static final String SESSION_USER_ID = "userId";
    public static final String SESSION_USERNAME = "username";

    // Default values
    public static final int DEFAULT_HTTP_PORT = 8080;
    public static final int MAX_CHANNELS_PER_SESSION = 10;
    public static final long IDLE_TIMEOUT_MS = 3 * 60 * 1000;
}
