package com.taller.auth.product.infrastructure;

import java.util.Optional;

import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;

import com.taller.auth.product.domain.Product;

/**
 * Contrato de persistencia para productos.
 *
 * Debido a que el sistema utiliza borrado logico, las operaciones normales
 * deben utilizar consultas que filtren explicitamente por active=true.
 *
 * Los metodos heredados de JpaRepository como findAll() y findById() no
 * aplican este filtro automaticamente y no deben utilizarse para consultas
 * funcionales de productos activos.
 */
public interface ProductRepository extends JpaRepository<Product, Long> {

    Optional<Product> findByIdAndActiveTrue(Long id);

    Page<Product> findAllByActiveTrue(Pageable pageable);

    Page<Product> findByNameContainingIgnoreCaseAndActiveTrue(
            String name,
            Pageable pageable
    );

    boolean existsByName(String name);

    boolean existsByNameAndIdNot(String name, Long id);
}