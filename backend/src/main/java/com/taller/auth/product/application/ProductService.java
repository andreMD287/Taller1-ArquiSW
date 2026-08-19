package com.taller.auth.product.application;

import com.taller.auth.dto.FieldViolation;
import com.taller.auth.exception.BusinessRuleViolationException;
import com.taller.auth.product.application.rules.ProductRuleEngine;
import com.taller.auth.product.application.rules.RuleViolation;
import com.taller.auth.product.domain.Product;
import com.taller.auth.product.infrastructure.ProductRepository;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

/**
 * Casos de uso de producto.
 *
 * No conoce HTTP: recibe y devuelve objetos de dominio, y los controladores se
 * encargan de traducir DTOs (ADR-006). Tampoco decide QUE es valido -eso vive
 * en el motor de reglas (ADR-003)-: aqui solo se orquesta cuando validar y que
 * hacer con el resultado.
 *
 * NUNCA usa los metodos heredados de JpaRepository (findAll, findById): esos
 * no filtran por active y devolverian productos dados de baja. Solo se usan
 * las consultas explicitas ...ActiveTrue que entrego Rol 2.
 */
@Service
public class ProductService {

    private final ProductRepository repository;
    private final ProductRuleEngine ruleEngine;

    public ProductService(ProductRepository repository, ProductRuleEngine ruleEngine) {
        this.repository = repository;
        this.ruleEngine = ruleEngine;
    }

    @Transactional
    public Product create(Product product) {
        validate(product);
        return save(product);
    }

    /**
     * Se cargan los datos vigentes y se les aplican los cambios ANTES de
     * validar: asi las reglas evaluan el producto tal como va a quedar, y no
     * el fragmento que mando el cliente. Es lo que permite, por ejemplo, que
     * guardar un producto sin cambiarle el nombre no se reporte como nombre
     * duplicado consigo mismo.
     */
    @Transactional
    public Product update(Long id, Product changes) {
        Product existing = requireActive(id);
        existing.applyChangesFrom(changes);
        validate(existing);
        return save(existing);
    }

    /**
     * Borrado logico. No hace falta llamar a save(): dentro de la transaccion,
     * JPA detecta el cambio de estado de la entidad gestionada y lo sincroniza
     * al hacer commit.
     */
    @Transactional
    public void deactivate(Long id) {
        requireActive(id).deactivate();
    }

    @Transactional(readOnly = true)
    public Product findActiveById(Long id) {
        return requireActive(id);
    }

    /**
     * Listado paginado, con busqueda opcional por nombre. Un nombre vacio o
     * ausente lista todo: es el caso normal del listado, no un error.
     */
    @Transactional(readOnly = true)
    public Page<Product> search(String name, Pageable pageable) {
        if (name == null || name.isBlank()) {
            return repository.findAllByActiveTrue(pageable);
        }
        return repository.findByNameContainingIgnoreCaseAndActiveTrue(name.trim(), pageable);
    }

    private Product requireActive(Long id) {
        return repository.findByIdAndActiveTrue(id)
                .orElseThrow(() -> new ProductNotFoundException(id));
    }

    private void validate(Product product) {
        List<RuleViolation> violations = ruleEngine.validate(product);
        if (violations.isEmpty()) {
            return;
        }
        // traduccion dominio -> transporte: RuleViolation es un tipo interno
        // del modulo y no se expone por HTTP (ADR-007).
        throw new BusinessRuleViolationException(violations.stream()
                .map(v -> new FieldViolation(v.rule(), v.field(), v.message()))
                .toList());
    }

    /**
     * saveAndFlush y no save: con save(), el INSERT se posterga hasta el
     * commit, que ocurre FUERA de este try, y la violacion de constraint
     * escaparia como un 500 en vez de traducirse. Forzando el flush aqui, la
     * excepcion se lanza dentro del bloque donde se puede tratar.
     *
     * Por que hace falta el catch si ya existe ProductNameMustBeUniqueRule:
     * entre el exists...() de la regla y el INSERT hay una ventana en la que
     * otra transaccion puede insertar el mismo nombre. La regla da el mensaje
     * util en el caso normal; la constraint uq_products_name es la que de
     * verdad impide el duplicado. Se responde lo mismo en ambos casos para
     * que el cliente no distinga una carrera perdida de un duplicado normal.
     */
    private Product save(Product product) {
        try {
            return repository.saveAndFlush(product);
        } catch (DataIntegrityViolationException e) {
            throw new BusinessRuleViolationException(List.of(new FieldViolation(
                    "name.must-be-unique", "name", "Ya existe un producto con ese nombre")));
        }
    }
}
