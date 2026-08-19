package com.taller.auth.product;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.taller.auth.dto.FieldViolation;
import com.taller.auth.exception.BusinessRuleViolationException;
import com.taller.auth.exception.GlobalExceptionHandler;
import com.taller.auth.product.api.ProductController;
import com.taller.auth.product.api.ProductRequest;
import com.taller.auth.product.application.ProductNotFoundException;
import com.taller.auth.product.application.ProductService;
import com.taller.auth.product.domain.Product;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageImpl;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.web.PageableHandlerMethodArgumentResolver;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.math.BigDecimal;
import java.util.List;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * Contrato HTTP del modulo de productos.
 *
 * Se usa standaloneSetup y no @WebMvcTest a proposito: no hay filtro JWT
 * todavia (pieza de Rol 2), asi que un contexto con la cadena de seguridad
 * real respondería 403 a todo y no dejaria probar nada. Aqui se verifica la
 * traduccion HTTP; la autorizacion se probara cuando existan
 * @EnableMethodSecurity y el filtro.
 */
@ExtendWith(MockitoExtension.class)
class ProductControllerTest {

    private static final BigDecimal PRECIO = new BigDecimal("19.99");

    @Mock
    private ProductService productService;

    private MockMvc mockMvc;
    private final ObjectMapper json = new ObjectMapper();

    @BeforeEach
    void setUp() {
        mockMvc = MockMvcBuilders.standaloneSetup(new ProductController(productService))
                .setCustomArgumentResolvers(new PageableHandlerMethodArgumentResolver())
                .setControllerAdvice(new GlobalExceptionHandler(new SimpleMeterRegistry()))
                .build();
    }

    @Test
    void crearUnProductoDevuelve201ConElRecursoCreado() throws Exception {
        when(productService.create(any())).thenReturn(new Product("Teclado", PRECIO, 10));

        mockMvc.perform(post("/api/products")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(json.writeValueAsString(new ProductRequest("Teclado", PRECIO, 10))))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.name").value("Teclado"))
                .andExpect(jsonPath("$.active").value(true));
    }

    // Validacion ESTRUCTURAL: la ataja Bean Validation antes de llegar al
    // servicio, y responde 400 (ADR-004).
    @Test
    void unNombreEnBlancoEs400YNoLlegaAlServicio() throws Exception {
        mockMvc.perform(post("/api/products")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(json.writeValueAsString(new ProductRequest("  ", PRECIO, 10))))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("validation_error"));

        verify(productService, org.mockito.Mockito.never()).create(any());
    }

    /**
     * Validacion de NEGOCIO: 422, con las violaciones estructuradas y su campo
     * para que Rol 3 pueda resaltar el input (ADR-007). El codigo distinto del
     * 400 anterior es lo que hace visible desde el cliente la separacion de
     * ADR-004 entre validacion estructural y semantica.
     */
    @Test
    void unaViolacionDeReglaDeNegocioEs422ConLasViolacionesEstructuradas() throws Exception {
        when(productService.create(any())).thenThrow(new BusinessRuleViolationException(List.of(
                new FieldViolation("price.must-be-positive", "price", "El precio debe ser mayor a 0"))));

        mockMvc.perform(post("/api/products")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(json.writeValueAsString(new ProductRequest("Teclado", BigDecimal.ZERO, 10))))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.code").value("business_rule_violation"))
                .andExpect(jsonPath("$.violations[0].field").value("price"))
                .andExpect(jsonPath("$.violations[0].rule").value("price.must-be-positive"));
    }

    @Test
    void unProductoInexistenteOInactivoEs404() throws Exception {
        when(productService.findActiveById(7L)).thenThrow(new ProductNotFoundException(7L));

        mockMvc.perform(get("/api/products/7"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("product_not_found"));
    }

    @Test
    void elListadoDevuelveLaFormaEstableDePagina() throws Exception {
        Page<Product> page = new PageImpl<>(List.of(new Product("Teclado", PRECIO, 10)),
                PageRequest.of(0, 20), 1);
        when(productService.search(any(), any())).thenReturn(page);

        mockMvc.perform(get("/api/products"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.content[0].name").value("Teclado"))
                .andExpect(jsonPath("$.page").value(0))
                .andExpect(jsonPath("$.totalElements").value(1))
                .andExpect(jsonPath("$.last").value(true))
                // no se filtra la forma interna del Page de Spring Data
                .andExpect(jsonPath("$.pageable").doesNotExist());
    }

    @Test
    void elParametroDeBusquedaSePropagaAlServicio() throws Exception {
        when(productService.search(eq("tecla"), any())).thenReturn(Page.empty());

        mockMvc.perform(get("/api/products").param("name", "tecla"))
                .andExpect(status().isOk());

        verify(productService).search(eq("tecla"), any());
    }

    @Test
    void borrarDevuelve204SinCuerpo() throws Exception {
        mockMvc.perform(delete("/api/products/7"))
                .andExpect(status().isNoContent());

        verify(productService).deactivate(7L);
    }

    @Test
    void borrarUnProductoInexistenteEs404() throws Exception {
        doThrow(new ProductNotFoundException(7L)).when(productService).deactivate(7L);

        mockMvc.perform(delete("/api/products/7"))
                .andExpect(status().isNotFound());
    }
}
