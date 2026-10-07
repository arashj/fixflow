# FixFlow: one image serving the API and the built React app on port 3000.
FROM node:22-alpine AS web
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node:22-alpine AS api
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app/backend
COPY --from=api /app/backend/package.json ./
COPY --from=api /app/backend/node_modules ./node_modules
COPY --from=api /app/backend/dist ./dist
COPY --from=api /app/backend/migrations ./migrations
COPY --from=web /app/frontend/dist /app/frontend/dist
RUN mkdir -p /app/uploads && chown node:node /app/uploads
USER node
ENV UPLOAD_DIR=/app/uploads PORT=3000
EXPOSE 3000
CMD ["node", "dist/main.js"]
