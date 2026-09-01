FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci
COPY web ./web
RUN npm run build

FROM node:22-alpine

WORKDIR /app

COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node data/.gitkeep ./data/.gitkeep
COPY --chown=node:node --from=build /app/dist ./dist

ENV PORT=8080
EXPOSE 8080

USER node

CMD ["node", "src/index.js"]
