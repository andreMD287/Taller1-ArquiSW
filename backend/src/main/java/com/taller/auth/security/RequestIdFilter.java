package com.taller.auth.security;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.UUID;

/**
 * Correlation id: sin esto no se puede reconstruir una caida de punta a
 * punta a traves de un canal remoto (HTTP presentacion->logica, JDBC
 * logica->datos). Lee X-Request-Id si el cliente lo manda, si no lo genera,
 * lo mete en el MDC para que todo log de la peticion lo incluya, y lo
 * devuelve en la respuesta.
 *
 * @Order(HIGHEST_PRECEDENCE) para que el requestId exista antes que
 * cualquier otro filtro (incluida la cadena de Spring Security) intente
 * loguear algo de esta peticion.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class RequestIdFilter extends OncePerRequestFilter {

    private static final String HEADER = "X-Request-Id";
    private static final Logger log = LoggerFactory.getLogger(RequestIdFilter.class);

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                     FilterChain filterChain) throws ServletException, IOException {
        String requestId = request.getHeader(HEADER);
        if (requestId == null || requestId.isBlank()) {
            requestId = UUID.randomUUID().toString();
        }
        MDC.put("requestId", requestId);
        response.setHeader(HEADER, requestId);

        long start = System.currentTimeMillis();
        try {
            filterChain.doFilter(request, response);
        } finally {
            long latencyMs = System.currentTimeMillis() - start;
            // log estructurado (ver JsonLogEncoder): event/status/latencyMs viajan
            // como key-value pairs de SLF4J 2, no como texto libre en el mensaje.
            log.atInfo()
                    .addKeyValue("event", "http_request")
                    .addKeyValue("path", request.getRequestURI())
                    .addKeyValue("status", response.getStatus())
                    .addKeyValue("latencyMs", latencyMs)
                    .log("http_request");
            MDC.remove("requestId");
        }
    }
}
