package com.taller.auth.product.api;

import com.taller.auth.dto.PageResponse;
import com.taller.auth.product.application.ProductService;
import com.taller.auth.product.domain.Product;
import jakarta.validation.Valid;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.data.web.PageableDefault;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Traduce HTTP hacia/desde ProductService. Sin logica de negocio aqui: las
 * reglas viven en el motor y la orquestacion en el servicio.
 *
 * AUTORIZACION: leer requiere estar autenticado, escribir requiere ADMIN.
 * Los @PreAuthorize de esta clase se aplican de verdad: SecurityConfig declara
 * @EnableMethodSecurity y JwtAuthenticationFilter construye el Authentication
 * con la autoridad ROLE_<rol> a partir del claim del JWT. Verificado por
 * ProductSecurityIT.
 */
@RestController
@RequestMapping("/api/products")
public class ProductController {

    private final ProductService productService;

    public ProductController(ProductService productService) {
        this.productService = productService;
    }

    /**
     * Listado paginado con busqueda opcional por nombre.
     *
     * El tamano de pagina esta acotado por spring.data.web.pageable.max-page-size
     * en application.yml: sin ese tope, un cliente podria pedir ?size=100000 y
     * tumbar el objetivo de rendimiento de <2s con una sola peticion.
     */
    @GetMapping
    public PageResponse<ProductResponse> list(
            @RequestParam(required = false) String name,
            @PageableDefault(size = 20, sort = "name", direction = Sort.Direction.ASC) Pageable pageable) {
        return PageResponse.from(productService.search(name, pageable), ProductMapper::toResponse);
    }

    @GetMapping("/{id}")
    public ProductResponse get(@PathVariable Long id) {
        return ProductMapper.toResponse(productService.findActiveById(id));
    }

    @PostMapping
    @PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<ProductResponse> create(@Valid @RequestBody ProductRequest request) {
        Product created = productService.create(ProductMapper.toDomain(request));
        return ResponseEntity.status(HttpStatus.CREATED).body(ProductMapper.toResponse(created));
    }

    @PutMapping("/{id}")
    @PreAuthorize("hasRole('ADMIN')")
    public ProductResponse update(@PathVariable Long id, @Valid @RequestBody ProductRequest request) {
        return ProductMapper.toResponse(productService.update(id, ProductMapper.toDomain(request)));
    }

    /**
     * Borrado LOGICO: la fila sobrevive con active=false. Se responde 204 sin
     * cuerpo porque, de cara al cliente, el producto deja de existir — que sea
     * un soft delete es un detalle de persistencia que no se filtra a la API.
     */
    @DeleteMapping("/{id}")
    @PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<Void> delete(@PathVariable Long id) {
        productService.deactivate(id);
        return ResponseEntity.noContent().build();
    }
}
