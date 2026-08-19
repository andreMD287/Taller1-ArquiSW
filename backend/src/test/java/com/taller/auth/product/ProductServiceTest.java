package com.taller.auth.product;

import com.taller.auth.dto.FieldViolation;
import com.taller.auth.exception.BusinessRuleViolationException;
import com.taller.auth.product.application.ProductNotFoundException;
import com.taller.auth.product.application.ProductService;
import com.taller.auth.product.application.rules.PriceMustBePositiveRule;
import com.taller.auth.product.application.rules.ProductNameMustBeUniqueRule;
import com.taller.auth.product.application.rules.ProductRuleEngine;
import com.taller.auth.product.application.rules.StockMustNotBeNegativeRule;
import com.taller.auth.product.domain.Product;
import com.taller.auth.product.infrastructure.ProductRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;

import java.math.BigDecimal;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class ProductServiceTest {

    private static final BigDecimal PRECIO = new BigDecimal("19.99");
    private static final Pageable PAGINA = PageRequest.of(0, 20);

    @Mock
    private ProductRepository repository;

    private ProductService service;

    @BeforeEach
    void setUp() {
        // motor real con las reglas reales: lo que se prueba aqui es la
        // orquestacion, no las reglas, pero con reglas de mentira el test no
        // demostraria que el servicio realmente las aplica.
        ProductRuleEngine engine = new ProductRuleEngine(List.of(
                new PriceMustBePositiveRule(),
                new StockMustNotBeNegativeRule(),
                new ProductNameMustBeUniqueRule(repository)));
        service = new ProductService(repository, engine);
    }

    @Test
    void createGuardaUnProductoValido() {
        when(repository.existsByName("Teclado")).thenReturn(false);
        when(repository.saveAndFlush(any())).thenAnswer(inv -> inv.getArgument(0));

        Product creado = service.create(new Product("Teclado", PRECIO, 10));

        assertThat(creado.getName()).isEqualTo("Teclado");
        assertThat(creado.isActive()).isTrue();
        verify(repository).saveAndFlush(any());
    }

    @Test
    void createAcumulaTodasLasViolacionesYNoGuarda() {
        Product invalido = new Product("Teclado", new BigDecimal("-1.00"), -5);

        assertThatThrownBy(() -> service.create(invalido))
                .isInstanceOf(BusinessRuleViolationException.class)
                .extracting(e -> ((BusinessRuleViolationException) e).getViolations())
                .asInstanceOf(org.assertj.core.api.InstanceOfAssertFactories.list(FieldViolation.class))
                .extracting(FieldViolation::rule)
                .contains("price.must-be-positive", "stock.must-not-be-negative");

        verify(repository, never()).saveAndFlush(any());
    }

    @Test
    void createRechazaUnNombreYaUsado() {
        when(repository.existsByName("Teclado")).thenReturn(true);

        assertThatThrownBy(() -> service.create(new Product("Teclado", PRECIO, 10)))
                .isInstanceOf(BusinessRuleViolationException.class);

        verify(repository, never()).saveAndFlush(any());
    }

    /**
     * La regla de unicidad no es la garantia, es el mensaje: si otra
     * transaccion gana la carrera entre el exists() y el INSERT, la constraint
     * de la base lanza DataIntegrityViolationException y el servicio la
     * traduce al mismo 422. Sin esto el usuario veria un 500.
     */
    @Test
    void unaCarreraPerdidaContraLaConstraintSeTraduceAlMismo422YNoAUn500() {
        when(repository.existsByName("Teclado")).thenReturn(false);
        when(repository.saveAndFlush(any())).thenThrow(new DataIntegrityViolationException("uq_products_name"));

        assertThatThrownBy(() -> service.create(new Product("Teclado", PRECIO, 10)))
                .isInstanceOf(BusinessRuleViolationException.class)
                .extracting(e -> ((BusinessRuleViolationException) e).getViolations())
                .asInstanceOf(org.assertj.core.api.InstanceOfAssertFactories.list(FieldViolation.class))
                .extracting(FieldViolation::rule)
                .containsExactly("name.must-be-unique");
    }

    @Test
    void updateSobreUnProductoInexistenteOInactivoEs404() {
        when(repository.findByIdAndActiveTrue(7L)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> service.update(7L, new Product("Teclado", PRECIO, 1)))
                .isInstanceOf(ProductNotFoundException.class);
    }

    // Guardar un producto sin cambiarle el nombre no debe reportarse como
    // duplicado consigo mismo: por eso la regla usa existsByNameAndIdNot en
    // cuanto el producto tiene id.
    @Test
    void updateSinCambiarElNombreNoLoReportaComoDuplicado() {
        Product existente = conId(new Product("Teclado", PRECIO, 10), 7L);
        when(repository.findByIdAndActiveTrue(7L)).thenReturn(Optional.of(existente));
        when(repository.existsByNameAndIdNot("Teclado", 7L)).thenReturn(false);
        when(repository.saveAndFlush(any())).thenAnswer(inv -> inv.getArgument(0));

        Product actualizado = service.update(7L, new Product("Teclado", new BigDecimal("25.00"), 4));

        assertThat(actualizado.getPrice()).isEqualByComparingTo("25.00");
        assertThat(actualizado.getStock()).isEqualTo(4);
        verify(repository, never()).existsByName(any());
    }

    @Test
    void deactivateMarcaInactivoSinBorrarLaFila() {
        Product existente = conId(new Product("Teclado", PRECIO, 10), 7L);
        when(repository.findByIdAndActiveTrue(7L)).thenReturn(Optional.of(existente));

        service.deactivate(7L);

        assertThat(existente.isActive()).isFalse();
        verify(repository, never()).delete(any());
        verify(repository, never()).deleteById(anyLong());
    }

    @Test
    void searchSinNombreListaTodosLosActivos() {
        when(repository.findAllByActiveTrue(PAGINA)).thenReturn(Page.empty());

        service.search("   ", PAGINA);

        verify(repository).findAllByActiveTrue(PAGINA);
        verify(repository, never()).findByNameContainingIgnoreCaseAndActiveTrue(any(), any());
    }

    @Test
    void searchConNombreDelegaEnLaConsultaFiltradaPorActivos() {
        when(repository.findByNameContainingIgnoreCaseAndActiveTrue("tecla", PAGINA)).thenReturn(Page.empty());

        service.search("  tecla  ", PAGINA);

        verify(repository).findByNameContainingIgnoreCaseAndActiveTrue("tecla", PAGINA);
    }

    /**
     * Con borrado logico y filtrado por metodos explicitos, el filtro no es
     * estructural: depende de que nadie llame a los metodos heredados de
     * JpaRepository, que devuelven tambien los productos dados de baja. Este
     * test convierte esa convencion en algo verificable.
     */
    @Test
    void nuncaSeUsanLosMetodosHeredadosQueNoFiltranPorActive() {
        Product existente = conId(new Product("Teclado", PRECIO, 10), 7L);
        when(repository.findByIdAndActiveTrue(7L)).thenReturn(Optional.of(existente));

        service.findActiveById(7L);
        service.deactivate(7L);

        verify(repository, never()).findById(anyLong());
        verify(repository, never()).findAll();
        verify(repository, never()).findAll(any(Pageable.class));
    }

    private static Product conId(Product product, Long id) {
        try {
            var field = Product.class.getDeclaredField("id");
            field.setAccessible(true);
            field.set(product, id);
            return product;
        } catch (ReflectiveOperationException e) {
            throw new RuntimeException(e);
        }
    }
}
