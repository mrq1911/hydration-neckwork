FROM node:22-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# Optional build-time URL of the Preis price-chart UI. Prefer the runtime
# PREIS_URL env var below: setting it here inlines the value into the bundle
# (import.meta.env.VITE_PREIS_URL), which ties the image to one deployment. This
# remains only as a fallback for images built without runtime configuration.
ARG VITE_PREIS_URL
ENV VITE_PREIS_URL=$VITE_PREIS_URL
RUN npm run build

FROM nginx:alpine

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
# Rewrites /config.js from PREIS_URL before nginx starts, so the sibling app's
# URL is a container setting rather than a build input.
COPY docker-entrypoint.d/40-runtime-config.sh /docker-entrypoint.d/40-runtime-config.sh

EXPOSE 80
