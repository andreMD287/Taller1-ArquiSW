# Imagen del tier de presentacion.
#
# Sin paso de build a proposito: la aplicacion usa modulos ES nativos del
# navegador, asi que no hay que transpilar ni empaquetar nada. La imagen es
# nginx mas los archivos estaticos, y eso es todo — no hay node_modules, no hay
# npm en el pipeline de Rol 4 y la superficie de la imagen es minima (ADR-F01).
FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/nginx.conf

COPY index.html /usr/share/nginx/html/index.html
COPY styles.css /usr/share/nginx/html/styles.css
COPY src/ /usr/share/nginx/html/src/

# config.js NO esta dentro de src/: es el enlace con el entorno, no artefacto
# (ADR-F01). Sin este COPY la imagen arranca y sirve el HTML, pero el primer
# import de la aplicacion falla con 404 y la pantalla queda en blanco.
COPY config.js /usr/share/nginx/html/config.js

# "Defer Binding / Resource files" (Cap. 8) aplicado en el despliegue: el unico
# valor que depende del entorno se fija AQUI, no en el codigo.
#
# En desarrollo, config.js apunta al backend en su puerto (ver GUIA-DE-USO). En
# esta imagen no puede: el navegador del usuario no es la maquina del backend.
# Se sustituye por cadena vacia = MISMO ORIGEN, con lo que resolveUrl() emite
# rutas relativas ("/api/products") que resuelve el proxy inverso de este mismo
# nginx. No se escribe ninguna URL de backend: el destino lo decide nginx.conf.
#
# El grep no es decorativo: si alguien renombra la constante en config.js, esta
# linea dejaria de aplicar en silencio y la imagen saldria apuntando a
# localhost. Asi la construccion falla y se entera quien la rompe.
RUN sed -i 's|^const DEFAULT_API_BASE_URL = .*|const DEFAULT_API_BASE_URL = "";|' \
        /usr/share/nginx/html/config.js \
 && grep -q '^const DEFAULT_API_BASE_URL = "";' /usr/share/nginx/html/config.js

# window.__APP_CONFIG__ sigue teniendo precedencia sobre este valor, asi que un
# despliegue puede seguir sobreescribiendo la base sin reconstruir la imagen.

EXPOSE 80

# 127.0.0.1 y no "localhost": dentro del contenedor localhost resuelve primero a
# ::1, y este nginx escucha "listen 80" — solo IPv4. Con localhost la sonda se
# conecta a [::1]:80 y recibe connection refused SIEMPRE, con lo que el
# contenedor queda unhealthy pese a servir correctamente. En Swarm eso es peor
# que un fallo visible: el servicio nunca converge y las tareas se reinician en
# bucle. Comprobado ejecutando la imagen.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1
