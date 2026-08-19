package com.taller.auth.product.application;

import com.taller.auth.dto.FieldViolation;
import com.taller.auth.exception.AppException;
import com.taller.auth.exception.BusinessRuleViolationException;
import com.taller.auth.exception.DataUnavailableException;
import io.github.resilience4j.circuitbreaker.annotation.CircuitBreaker;
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

    @CircuitBreaker(name = "dataTier", fallbackMethod = "createFallback")
    @Transactional
    public Product create(Product product) {
        validate(product);
        return save(product);
    }

    @SuppressWarnings("unused")
    private Product createFallback(Product product, Throwable t) {
        return failOrDegrade(t);
    }

    /**
     * Se cargan los datos vigentes y se les aplican los cambios ANTES de
     * validar: asi las reglas evaluan el producto tal como va a quedar, y no
     * el fragmento que mando el cliente. Es lo que permite, por ejemplo, que
     * guardar un producto sin cambiarle el nombre no se reporte como nombre
     * duplicado consigo mismo.
     */
    @CircuitBreaker(name = "dataTier", fallbackMethod = "updateFallback")
    @Transactional
    public Product update(Long id, Product changes) {
        Product existing = requireActive(id);
        existing.applyChangesFrom(changes);
        validate(existing);
        return save(existing);
    }

    @SuppressWarnings("unused")
    private Product updateFallback(Long id, Product changes, Throwable t) {
        return failOrDegrade(t);
    }

    /**
     * Borrado logico. No hace falta llamar a save(): dentro de la transaccion,
     * JPA detecta el cambio de estado de la entidad gestionada y lo sincroniza
     * al hacer commit.
     */
    @CircuitBreaker(name = "dataTier", fallbackMethod = "deactivateFallback")
    @Transactional
    public void deactivate(Long id) {
        requireActive(id).deactivate();
    }

    @SuppressWarnings("unused")
    private void deactivateFallback(Long id, Throwable t) {
        failOrDegrade(t);
    }

    @CircuitBreaker(name = "dataTier", fallbackMethod = "findActiveByIdFallback")
    @Transactional(readOnly = true)
    public Product findActiveById(Long id) {
        return requireActive(id);
    }

    @SuppressWarnings("unused")
    private Product findActiveByIdFallback(Long id, Throwable t) {
        return failOrDegrade(t);
    }

    /**
     * Listado paginado, con busqueda opcional por nombre. Un nombre vacio o
     * ausente lista todo: es el caso normal del listado, no un error.
     */
    @CircuitBreaker(name = "dataTier", fallbackMethod = "searchFallback")
    @Transactional(readOnly = true)
    public Page<Product> search(String name, Pageable pageable) {
        if (name == null || name.isBlank()) {
            return repository.findAllByActiveTrue(pageable);
        }
        return repository.findByNameContainingIgnoreCaseAndActiveTrue(name.trim(), pageable);
    }

    @SuppressWarnings("unused")
    private Page<Product> searchFallback(String name, Pageable pageable, Throwable t) {
        return failOrDegrade(t);
    }

    /**
     * Resilience4j manda al fallback CUALQUIER excepcion, no solo las fallas
     * reales de infraestructura. Un AppException -un producto no encontrado,
     * una regla de negocio incumplida- es EXPECTED (Cap. 4) y debe propagarse
     * tal cual: si se disfrazara de 503, un precio invalido contaria como
     * caida del tier de datos en el modelo de disponibilidad.
     *
     * Mismo patron que AuthService.registerFallback y TokenService.issueFallback.
     */
    private static <T> T failOrDegrade(Throwable t) {
        if (t instanceof AppException appException) {
            throw appException;
        }
        throw new DataUnavailableException(t);
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
