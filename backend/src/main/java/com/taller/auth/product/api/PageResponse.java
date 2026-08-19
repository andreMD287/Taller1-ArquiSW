package com.taller.auth.product.api;

import org.springframework.data.domain.Page;

import java.util.List;
import java.util.function.Function;

/**
 * Pagina de resultados en su forma de transporte.
 *
 * Existe por la misma razon que ProductResponse (ADR-006): no se expone un
 * tipo interno por HTTP. Serializar directamente el Page de Spring Data
 * publicaria la forma de una clase del framework -con campos como "pageable",
 * "sort" y "numberOfElements"- que puede cambiar entre versiones de Spring y
 * dejaria a Rol 3 acoplado a ella. Spring Boot 3.3 incluso advierte en el log
 * contra hacerlo.
 *
 * @param content       elementos de esta pagina.
 * @param page          indice de pagina, empezando en 0.
 * @param size          tamano de pagina solicitado.
 * @param totalElements total de elementos que cumplen el filtro.
 * @param totalPages    total de paginas disponibles.
 * @param last          si esta es la ultima pagina.
 */
public record PageResponse<T>(
        List<T> content,
        int page,
        int size,
        long totalElements,
        int totalPages,
        boolean last
) {

    public static <S, T> PageResponse<T> from(Page<S> page, Function<S, T> mapper) {
        return new PageResponse<>(
                page.getContent().stream().map(mapper).toList(),
                page.getNumber(),
                page.getSize(),
                page.getTotalElements(),
                page.getTotalPages(),
                page.isLast());
    }
}
