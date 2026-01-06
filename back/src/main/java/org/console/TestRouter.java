package org.console;

import io.vertx.core.Vertx;
import io.vertx.ext.web.Router;
import io.vertx.ext.web.handler.sockjs.SockJSHandler;
import io.vertx.ext.web.handler.sockjs.SockJSBridgeOptions;

public class TestRouter {
    public static void main(String[] args) {
        Vertx vertx = Vertx.vertx();
        Router router = Router.router(vertx);
        System.out.println("Router class: " + router.getClass().getName());
        
        try {
            Router handler = SockJSHandler.create(vertx).bridge(new SockJSBridgeOptions());
            System.out.println("Handler class: " + handler.getClass().getName());
            
            router.route("/eventbus/*").subRouter(handler);
            System.out.println("Successfully called subRouter");
        } catch (Throwable e) {
            e.printStackTrace();
        } finally {
            vertx.close();
        }
    }
}
