package com.taller.auth.product.infrastructure;

import java.util.Optional;

import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import com.taller.auth.product.domain.Product;

/**
 * Contrato de persistencia para productos.
 *
 * El borrado logico se aplica mediante consultas explicitas active=true.
 * Los metodos heredados findAll/findById no deben utilizarse para las
 * operaciones funcionales del CRUD.
 */
public interface ProductRepository extends JpaRepository<Product, Long> {

    Optional<Product> findByIdAndActiveTrue(Long id);

    Page<Product> findAllByActiveTrue(Pageable pageable);

    /**
     * Busqueda parcial case-insensitive.
     *
     * Se expresa explicitamente con lower(name) para que PostgreSQL pueda
     * aprovechar el indice trigram GIN definido sobre lower(name).
     */
    @Query("""
            select p
            from Product p
            where p.active = true
              and lower(p.name) like lower(concat('%', :name, '%'))
            """)
    Page<Product> findByNameContainingIgnoreCaseAndActiveTrue(
            @Param("name") String name,
            Pageable pageable
    );

    boolean existsByName(String name);

    boolean existsByNameAndIdNot(String name, Long id);
}