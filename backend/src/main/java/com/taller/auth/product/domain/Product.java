package com.taller.auth.product.domain;

import java.math.BigDecimal;
import java.time.Instant;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

/**
 * Entidad de persistencia para productos.
 *
 * El borrado es logico mediante active=false. Los repositorios deben utilizar
 * consultas explicitas que filtren por active=true cuando la operacion trabaje
 * unicamente con productos vigentes.
 *
 * price usa BigDecimal para representar valores monetarios sin los errores de
 * precision propios del punto flotante binario.
 */
@Entity
@Table(name = "products")
public class Product {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, unique = true)
    private String name;

    @Column(nullable = false, precision = 12, scale = 2)
    private BigDecimal price;

    @Column(nullable = false)
    private int stock;

    @Column(nullable = false)
    private boolean active;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    protected Product() {
        // requerido por JPA
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

    /**
     * Copia sobre este producto los campos que el cliente puede modificar.
     *
     * id, active y createdAt NO se copian: el id es inmutable, active solo
     * cambia por deactivate() y createdAt es auditoria que el cliente no
     * gobierna. Sin esto, una actualizacion podria reescribir la fecha de
     * creacion o resucitar un producto dado de baja.
     *
     * Vive en el dominio y no en el mapper a proposito: al agregar un atributo
     * nuevo, el campo y la regla de que sea editable quedan en el MISMO
     * archivo. Es una de las razones por las que el ejercicio cronometrado no
     * se dispersa.
     */
    public void applyChangesFrom(Product changes) {
        this.name = changes.getName();
        this.price = changes.getPrice();
        this.stock = changes.getStock();
    }

    public boolean isActive() {
        return active;
    }

    /**
     * Soft delete.
     *
     * No elimina fisicamente la fila para preservar referencias e historial.
     */
    public void deactivate() {
        this.active = false;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }
}