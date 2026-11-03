# Servicio de licencias de Sulotec. Imagen arm64/amd64 (node:24-alpine es multiarquitectura).
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY bd ./bd
COPY src ./src
COPY scripts ./scripts
USER node
EXPOSE 3200
CMD ["node", "src/servidor.js"]
