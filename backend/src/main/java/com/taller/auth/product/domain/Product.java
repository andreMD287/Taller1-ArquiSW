package com.taller.auth.product.domain;

import java.math.BigDecimal;
import java.time.Instant;

/**
 * PLACEHOLDER DE ROL 1 — PENDIENTE DE ROL 2.
 *
 * Esta clase existe para que el motor de reglas y sus tests compilen sin
 * esperar a Rol 2. Es un POJO plano: NO tiene anotaciones JPA todavia.
 *
 * Lo que Rol 2 debe hacer sobre ESTE archivo (no crear otro Product en otro
 * paquete: rompe la estructura acordada en ADR-001):
 *   - @Entity y @Table(name = "products")
 *   - @Id @GeneratedValue(strategy = GenerationType.IDENTITY) sobre id
 *   - @Column(nullable = false, unique = true) sobre name
 *   - @Column(nullable = false, precision = 12, scale = 2) sobre price
 *   - @Column(nullable = false) sobre stock, active y createdAt
 *   - la estrategia de filtrado de soft-delete que se decida (punto 3 del
 *     checklist): @Where(clause = "active = true") o metodos explicitos.
 *
 * price es BigDecimal y no double a proposito: es dinero, y la aritmetica
 * binaria de punto flotante no representa exactamente valores decimales.
 *
 * El conjunto de campos es deliberadamente minimo: el ejercicio cronometrado
 * de modificabilidad consiste en agregar un atributo nuevo, y ese debe ser el
 * primero que se agregue, no el quinto.
 */
public class Product {

    private Long id;
    private String name;
    private BigDecimal price;
    private int stock;
    private boolean active;
    private Instant createdAt;

    protected Product() {
        // requerido por JPA cuando Rol 2 anote la clase
    }

    public Product(String name, BigDecimal price, int stock) {
        this.name = name;
        this.price = price;
        this.stock = stock;
        this.active = true;
        this.createdAt = Instant.now();
    }

    public Long getId() {
        return id;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public BigDecimal getPrice() {
        return price;
    }

    public void setPrice(BigDecimal price) {
        this.price = price;
    }

    public int getStock() {
        return stock;
    }

    public void setStock(int stock) {
        this.stock = stock;
    }

    public boolean isActive() {
        return active;
    }

    /**
     * Borrado logico (regla cerrada de negocio): un producto eliminado deja de
     * listarse, pero su fila sobrevive para no romper referencias historicas.
     */
    public void deactivate() {
        this.active = false;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }
}
