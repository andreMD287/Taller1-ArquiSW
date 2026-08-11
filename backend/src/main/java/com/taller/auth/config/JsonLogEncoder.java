package com.taller.auth.config;

import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.classic.spi.IThrowableProxy;
import ch.qos.logback.classic.spi.ThrowableProxyUtil;
import ch.qos.logback.core.encoder.EncoderBase;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.event.KeyValuePair;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Encoder de logs en JSON sin dependencias adicionales: usa Jackson (ya
 * viaja con spring-boot-starter-web) y el soporte de key-value pairs de
 * SLF4J 2 / Logback 1.5 (log.atInfo().addKeyValue(...)). Sin un requestId
 * uniforme en cada linea no se puede reconstruir una caida de punta a punta.
 *
 * Campos emitidos: ts, level, requestId, node, event, latencyMs, status
 * (los ultimos tres llegan via MDC o via addKeyValue, segun el caso).
 */
public class JsonLogEncoder extends EncoderBase<ILoggingEvent> {

    private final ObjectMapper mapper = new ObjectMapper();

    @Override
    public byte[] headerBytes() {
        return new byte[0];
    }

    @Override
    public byte[] encode(ILoggingEvent event) {
        Map<String, Object> fields = new LinkedHashMap<>();
        fields.put("ts", Instant.ofEpochMilli(event.getTimeStamp()).toString());
        fields.put("level", event.getLevel().toString());
        fields.put("logger", event.getLoggerName());
        // nodeId viene de una springProperty de contexto (logback-spring.xml), no de
        // MDC: asi tambien aparece en logs de hilos de @Scheduled, no solo de peticiones.
        fields.put("node", event.getLoggerContextVO().getPropertyMap().getOrDefault("nodeId", "unknown"));
        fields.put("event", event.getFormattedMessage());

        Map<String, String> mdc = event.getMDCPropertyMap();
        if (mdc != null) {
            fields.putAll(mdc);
        }
        if (event.getKeyValuePairs() != null) {
            for (KeyValuePair kv : event.getKeyValuePairs()) {
                fields.put(kv.key, kv.value);
            }
        }

        IThrowableProxy throwableProxy = event.getThrowableProxy();
        if (throwableProxy != null) {
            fields.put("stack", ThrowableProxyUtil.asString(throwableProxy));
        }

        try {
            return (mapper.writeValueAsString(fields) + System.lineSeparator()).getBytes(StandardCharsets.UTF_8);
        } catch (Exception e) {
            return (event.getFormattedMessage() + System.lineSeparator()).getBytes(StandardCharsets.UTF_8);
        }
    }

    @Override
    public byte[] footerBytes() {
        return new byte[0];
    }
}
