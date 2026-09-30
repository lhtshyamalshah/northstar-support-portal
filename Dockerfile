# Single-container production image: Express serves the API and the built SPA,
# which is what server.mjs already does when NODE_ENV=production.
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY package/ ./package/

# The governance SDK is a local file: dependency; its dist/ must exist before the
# root install packs it.
RUN npm --prefix package/zbrain-governance-sdk install --engine-strict=false --no-audit --no-fund \
 && npm --prefix package/zbrain-governance-sdk run build \
 && npm install --no-audit --no-fund

COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY --from=build /app/server.mjs ./server.mjs
COPY --from=build /app/governance.mjs ./governance.mjs
COPY --from=build /app/governance ./governance

EXPOSE 4000
# Called directly rather than through `npm start`, whose prestart rebuilds the SDK.
CMD ["node", "server.mjs"]
