package com.taller.auth.product;

import com.taller.auth.product.application.rules.ProductRule;
import com.taller.auth.product.application.rules.ProductRuleEngine;
import com.taller.auth.product.application.rules.RuleViolation;
import com.taller.auth.product.domain.Product;
import com.taller.auth.product.infrastructure.ProductRepository;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.ComponentScan;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

import java.math.BigDecimal;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * EVIDENCIA DE ADR-003 (tactica "defer binding", Cap. 8).
 *
 * Los tests anteriores le pasan la lista de reglas al motor a mano. Este
 * comprueba lo que de verdad sostiene el escenario de modificabilidad: que
 * NADIE registra las reglas, que el contenedor de Spring las descubre solo
 * por implementar la interfaz, y que basta con que una clase nueva exista en
 * el classpath para que el motor la aplique.
 *
 * Se usa ApplicationContextRunner en vez de @SpringBootTest a proposito: solo
 * levanta el paquete de reglas, sin base de datos ni servidor web, asi que
 * corre en milisegundos.
 */
class ProductRuleDiscoveryTest {

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withUserConfiguration(RulesScanConfig.class);

    @Test
    void springDescubreLasReglasSinRegistroExplicitoDeNadie() {
        runner.run(context -> {
            ProductRuleEngine engine = context.getBean(ProductRuleEngine.class);

            assertThat(engine.activeRuleNames())
                    .contains("PriceMustBePositiveRule", "StockMustNotBeNegativeRule");
        });
    }

    /**
     * El ejercicio cronometrado en miniatura: se agrega una clase que
     * implementa ProductRule y se comprueba que el motor la aplica. No se
     * modifico ProductRuleEngine, ni un registro, ni un enum, ni un archivo
     * de configuracion. Cero archivos existentes tocados.
     */
    @Test
    void unaReglaNuevaEnElClasspathQuedaActivaSinTocarNingunArchivoExistente() {
        runner.withUserConfiguration(ReglaAgregadaDespues.class).run(context -> {
            ProductRuleEngine engine = context.getBean(ProductRuleEngine.class);

            assertThat(engine.activeRuleNames()).contains("ReglaAgregadaDespues");

            var violations = engine.validate(new Product("XX-Teclado", new BigDecimal("19.99"), 5));
            assertThat(violations).extracting(RuleViolation::rule).contains("name.reserved-prefix");
        });
    }

    /**
     * EVIDENCIA DE ADR-005 (feature toggles). Una regla apagada por
     * configuracion no se instancia siquiera: no aparece en el catalogo y no
     * se evalua. El coste de una regla apagada es literalmente cero, a
     * diferencia de un `if (habilitada)` dentro del metodo.
     */
    @Test
    void unaReglaConToggleApagadoNiSiquieraLlegaASerBean() {
        runner.withUserConfiguration(ReglaConToggle.class).run(context -> {
            ProductRuleEngine engine = context.getBean(ProductRuleEngine.class);

            assertThat(engine.activeRuleNames()).doesNotContain("ReglaConToggle");
            assertThat(engine.validate(new Product("ZZ-Teclado", new BigDecimal("19.99"), 5))).isEmpty();
        });
    }

    /**
     * El binding se resuelve a tiempo de CONFIGURACION, no de compilacion: el
     * mismo artefacto compilado se comporta distinto solo por una propiedad.
     */
    @Test
    void laMismaReglaSeActivaSoloCambiandoUnaPropiedadSinRecompilar() {
        runner.withUserConfiguration(ReglaConToggle.class)
                .withPropertyValues("features.rules.name-reserved-prefix=true")
                .run(context -> {
                    ProductRuleEngine engine = context.getBean(ProductRuleEngine.class);

                    assertThat(engine.activeRuleNames()).contains("ReglaConToggle");
                    assertThat(engine.validate(new Product("ZZ-Teclado", new BigDecimal("19.99"), 5)))
                            .extracting(RuleViolation::rule)
                            .containsExactly("name.reserved-prefix");
                });
    }

    /**
     * El contexto se limita al paquete de reglas: sin base de datos, sin web.
     * ProductRepository se provee simulado porque ProductNameMustBeUniqueRule
     * lo necesita — es el precio de que una regla pueda consultar
     * persistencia, y por eso las reglas viven en application y no en domain
     * (ADR-003).
     */
    @Configuration
    @ComponentScan("com.taller.auth.product.application.rules")
    static class RulesScanConfig {

        @Bean
        ProductRepository productRepository() {
            return Mockito.mock(ProductRepository.class);
        }
    }

    @Component
    @Order(40)
    @ConditionalOnProperty(name = "features.rules.name-reserved-prefix", havingValue = "true")
    static class ReglaConToggle implements ProductRule {

        @Override
        public Optional<RuleViolation> check(Product product) {
            return product.getName() != null && product.getName().startsWith("ZZ")
                    ? Optional.of(new RuleViolation("name.reserved-prefix", "name", "Prefijo reservado"))
                    : Optional.empty();
        }
    }

    @Component
    @Order(30)
    static class ReglaAgregadaDespues implements ProductRule {

        @Override
        public Optional<RuleViolation> check(Product product) {
            return product.getName() != null && product.getName().startsWith("XX")
                    ? Optional.of(new RuleViolation("name.reserved-prefix", "name", "Prefijo reservado"))
                    : Optional.empty();
        }
    }
}
