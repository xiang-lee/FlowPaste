FROM node:20-alpine AS base
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package*.json ./
RUN npm ci

COPY . .

RUN npm run build

EXPOSE 8000

CMD sh -c "PORT=\${PORT:-8000} npm run start"
