package com.taller.auth.unit;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.web.cors.CorsConfigurationSource;

import com.taller.auth.config.CorsConfig;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Guarda contra un fallo silencioso de configuracion.
 *
 * CorsConfig lee app.cors.allowed-origins con un valor por defecto que coincide
 * con el que trae application.yml. Eso significa que si la clave del YAML se
 * escribe mal -mal indentada, colgando del bloque equivocado- el sistema
 * SIGUE FUNCIONANDO igual y nadie se entera, hasta el dia en que alguien
 * agrega el origen de produccion y descubre que nunca se aplico.
 *
 * Ocurrio de verdad: la clave llego indentada bajo app.jwt y con
 * allowed-origins como hermano de cors en vez de hijo.
 *
 * Este test usa un origen que NO puede venir del valor por defecto, asi que
 * solo pasa si la propiedad se esta leyendo realmente.
 */
class CorsConfigTest {

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withUserConfiguration(CorsConfig.class);

    private static MockHttpServletRequest peticion() {
        return new MockHttpServletRequest("GET", "/api/products");
    }

    @Test
    void laPropiedadDelYamlSeLeeDeVerdadYNoSeQuedaEnElValorPorDefecto() {
        runner.withPropertyValues("app.cors.allowed-origins=https://origen-de-prueba.example")
                .run(context -> {
                    CorsConfigurationSource source = context.getBean(CorsConfigurationSource.class);

                    assertThat(source.getCorsConfiguration(peticion()).getAllowedOrigins())
                            .containsExactly("https://origen-de-prueba.example");
                });
    }

    @Test
    void aceptaVariosOrigenesSeparadosPorComa() {
        runner.withPropertyValues("app.cors.allowed-origins=https://uno.example,https://dos.example")
                .run(context -> {
                    CorsConfigurationSource source = context.getBean(CorsConfigurationSource.class);

                    assertThat(source.getCorsConfiguration(peticion()).getAllowedOrigins())
                            .containsExactly("https://uno.example", "https://dos.example");
                });
    }

    // Sin la propiedad definida se cae al valor por defecto: desarrollo local.
    // No es "*": eso era la configuracion anterior y se cerro a proposito.
    @Test
    void sinLaPropiedadCaeAlOrigenDeDesarrolloYNuncaAComodin() {
        runner.run(context -> {
            CorsConfigurationSource source = context.getBean(CorsConfigurationSource.class);

            assertThat(source.getCorsConfiguration(peticion()).getAllowedOrigins())
                    .containsExactly("http://localhost:8123", "http://127.0.0.1:8123")
                    .doesNotContain("*");
        });
    }
}
