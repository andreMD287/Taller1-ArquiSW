# Imagen del tier de presentacion.
#
# Sin paso de build a proposito: el MVC usa modulos ES nativos del navegador,
# asi que no hay que transpilar ni empaquetar nada. La imagen es nginx mas los
# archivos estaticos, y eso es todo — no hay node_modules, no hay npm en el
# pipeline de Rol 4 y la superficie de la imagen es minima.
FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/nginx.conf

COPY index.html /usr/share/nginx/html/index.html
COPY styles.css /usr/share/nginx/html/styles.css
COPY src/ /usr/share/nginx/html/src/

EXPOSE 80

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null http://localhost/healthz || exit 1
