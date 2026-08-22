# Ejercicio cronometrado de modificabilidad

Guion reproducible para verificar **ESC-M1** (§4.3 del documento de arquitectura):

> Un desarrollador agrega un atributo nuevo a `Producto` junto con una regla de negocio
> que lo valide.
>
> **Medida de respuesta:** ≤3 módulos · 0 archivos existentes modificados en el motor de
> reglas · 0 archivos del módulo de usuarios · <3 h · 0 defectos nuevos.

El ejercicio está diseñado para ejecutarse **en vivo**, cronómetro en mano. Todo el código
que hay que escribir está aquí: el objetivo no es inventar la solución sino **medir cuánto
cuesta aplicarla** sobre esta arquitectura.

---

## El cambio a implementar

Agregar a `Producto` un **código de producto (`sku`)**, opcional, con una regla de negocio:
**si viene, debe empezar por `SKU-`**.

Se eligió este atributo a propósito: ADR-008 registra que la unicidad del producto está
hoy sobre el nombre *"a falta de un SKU/código propio"*, y que si algún día se agrega uno,
la unicidad debería moverse allí. El ejercicio es entonces el primer paso real de una
evolución ya prevista, no un cambio inventado para la demostración.

La separación de validaciones que exige ADR-004 queda ejercitada de una vez:

| Tipo | Regla | Dónde va |
|---|---|---|
| Estructural | longitud máxima de 32 caracteres | `@Size` en el DTO |
| Negocio | debe empezar por `SKU-` | Motor de reglas |

---

## Antes de arrancar el cronómetro

```bash
git checkout -b ejercicio-modificabilidad
cd backend && ./mvnw test        # debe pasar: es la línea base
```

Anota el número de tests. Al terminar debe ser **el mismo más los que agregues**, y
**ningún test existente puede haber cambiado**.

---

## Archivos que SÍ se tocan

| # | Archivo | Acción |
|---|---|---|
| 1 | `backend/src/main/java/com/taller/auth/product/domain/Product.java` | modificar |
| 2 | `backend/src/main/java/com/taller/auth/product/api/ProductRequest.java` | modificar |
| 3 | `backend/src/main/java/com/taller/auth/product/api/ProductResponse.java` | modificar |
| 4 | `backend/src/main/java/com/taller/auth/product/api/ProductMapper.java` | modificar |
| 5 | `backend/src/main/java/com/taller/auth/product/application/rules/SkuMustHavePrefixRule.java` | **crear** |
| 6 | `frontend/src/resources/products.js` | modificar |
| 7 | `backend/src/main/resources/db/migration/V6__product_sku.sql` | **crear** |

## Archivos que NO se tocan — y esto es lo que se está midiendo

Si al terminar alguno de estos aparece en `git diff --stat`, **la medida de respuesta
falló** aunque el código funcione:

- `ProductRuleEngine.java` — el motor no se entera de que hay una regla nueva
- `ProductRule.java` — el contrato no cambia
- Cualquier otra regla existente (`PriceMustBePositiveRule`, `StockMustNotBeNegativeRule`, `ProductNameMustBeUniqueRule`)
- `ProductService.java`, `ProductController.java`
- Cualquier archivo de `com.taller.auth.controller`, `service`, `repository`, `model` (módulo de usuarios y autenticación)
- Cualquier archivo de `frontend/src/crud/`, `frontend/src/platform/`, `frontend/src/view/`
- **Cualquier test existente**

---

## Pasos

### 1. Entidad — `Product.java`

Agregar el campo, su columna, el par de accesores, y **la línea en `applyChangesFrom`**
que lo declara editable:

```java
@Column(length = 32)
private String sku;
```

```java
public String getSku() {
    return sku;
}

public void setSku(String sku) {
    this.sku = sku;
}
```

En `applyChangesFrom(Product changes)`, agregar:

```java
this.sku = changes.getSku();
```

> Olvidar esta última línea es el error más probable del ejercicio: el atributo se podría
> crear pero no editar. Está aquí a propósito para que el cronómetro lo capture si ocurre.

### 2. DTO de entrada — `ProductRequest.java`

Solo validación **estructural**. No se declara aquí la regla del prefijo:

```java
@Size(max = 32)
String sku
```

### 3. DTO de salida — `ProductResponse.java`

```java
String sku
```

### 4. Mapeo — `ProductMapper.java`

En `toDomain`, tras construir el producto:

```java
Product product = new Product(request.name(), request.price(), request.stock());
product.setSku(request.sku());
return product;
```

En `toResponse`, agregar `product.getSku()` en la posición correspondiente.

### 5. La regla — archivo NUEVO

`backend/src/main/java/com/taller/auth/product/application/rules/SkuMustHavePrefixRule.java`

```java
package com.taller.auth.product.application.rules;

import com.taller.auth.product.domain.Product;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

import java.util.Optional;

/**
 * El codigo de producto, si viene, debe empezar por "SKU-".
 *
 * Un sku ausente no es asunto de esta regla: el campo es opcional y su
 * longitud la valida @Size en el DTO (ADR-004).
 */
@Component
@Order(40)
public class SkuMustHavePrefixRule implements ProductRule {

    @Override
    public Optional<RuleViolation> check(Product product) {
        String sku = product.getSku();
        if (sku == null || sku.isBlank() || sku.startsWith("SKU-")) {
            return Optional.empty();
        }
        return Optional.of(new RuleViolation(
                "sku.must-have-prefix",
                "sku",
                "El codigo de producto debe empezar por SKU-"));
    }
}
```

**Este es el momento clave del ejercicio.** No hay que registrar la clase en ninguna parte:
Spring la descubre por implementar `ProductRule` y `ProductRuleEngine` la recibe en su
`List<ProductRule>` inyectada. Cero archivos existentes modificados.

### 6. Descriptor del frontend — `frontend/src/resources/products.js`

Una entrada en el array `fields`:

```javascript
{
    name: "sku",
    label: "Código",
    type: "text",
    maxLength: 32,       // @Size(max = 32) en ProductRequest
    inList: true,
    sortable: false,
    align: "left"
},
```

Datos, no comportamiento. Ningún otro archivo del frontend cambia.

### 7. Migración — archivo NUEVO *(territorio de Rol 2)*

`backend/src/main/resources/db/migration/V6__product_sku.sql`

```sql
-- Codigo de producto. Nullable: los productos existentes no tienen uno.
ALTER TABLE products ADD COLUMN sku VARCHAR(32);
```

---

## Verificación

```bash
cd backend && ./mvnw test
```

Debe pasar **sin haber modificado ningún test existente**.

Prueba manual del comportamiento nuevo:

```bash
# rechazado: 422 con violations[0].field == "sku"
curl -s -X POST http://localhost:8080/api/products \
  -H "Authorization: Bearer $TOKEN_ADMIN" -H "Content-Type: application/json" \
  -d '{"name":"Teclado","price":19.99,"stock":5,"sku":"XX-1"}'

# aceptado: 201
curl -s -X POST http://localhost:8080/api/products \
  -H "Authorization: Bearer $TOKEN_ADMIN" -H "Content-Type: application/json" \
  -d '{"name":"Teclado","price":19.99,"stock":5,"sku":"SKU-1"}'
```

---

## Recolección de la medida

```bash
git diff --stat                      # archivos tocados
git status --porcelain | grep '^??'  # archivos nuevos
```

Plantilla para anotar el resultado:

| Métrica | Objetivo | Medido |
|---|---|---|
| Módulos tocados | ≤3 | |
| Archivos modificados | 5 | |
| Archivos nuevos | 2 | |
| Archivos existentes tocados **en el motor de reglas** | **0** | |
| Archivos del módulo de usuarios tocados | **0** | |
| Tests existentes modificados | **0** | |
| Tiempo total | <3 h | |
| Tests fallando al terminar | 0 | |

### Comprobación automática de las medidas que son cero

```bash
# El motor de reglas no debe aparecer
git diff --name-only | grep -E 'ProductRuleEngine|rules/(Price|Stock|ProductName)' \
  && echo "FALLO: se tocó el motor de reglas" || echo "OK: motor intacto"

# El módulo de usuarios no debe aparecer
git diff --name-only | grep -E 'auth/(controller|service|repository|model)/' \
  && echo "FALLO: se tocó el módulo de usuarios" || echo "OK: usuarios intacto"

# Ningún test existente modificado (los nuevos son archivos sin seguimiento)
git diff --name-only | grep 'src/test' \
  && echo "FALLO: se modificó un test existente" || echo "OK: tests intactos"
```

---

## Parte B (opcional) — ESC-M2, desactivar la regla sin recompilar

Demuestra el *feature toggle* de ADR-005 sobre la regla que se acaba de crear.

1. Anotar `SkuMustHavePrefixRule` con:

```java
@ConditionalOnProperty(name = "features.rules.sku-prefix", havingValue = "true")
```

2. Declararla en el bloque `features.rules` de `application.yml`.

Con la propiedad en `false` o ausente, **la regla ni siquiera se instancia**: no aparece en
`ProductRuleEngine.activeRuleNames()` y su costo en ejecución es cero. Pasar de activa a
inactiva no toca una sola línea de código Java.

**Medida de ESC-M2:** 0 archivos modificados y 0 recompilaciones para cambiar el
comportamiento — solo configuración y reinicio.

---

## Al terminar

```bash
git checkout main
git branch -D ejercicio-modificabilidad
```

El ejercicio es una **medición**, no una entrega: el `sku` no se incorpora al sistema salvo
que se decida por separado. Si se decidiera, habría que retomar ADR-008 y mover la unicidad
del nombre al código de producto.
