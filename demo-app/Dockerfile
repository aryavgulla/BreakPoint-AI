FROM node:20-alpine

LABEL org.opencontainers.image.title="BreakPoint AI — Demo App"
LABEL org.opencontainers.image.description="Vulnerable microservice target for BreakPoint AI fuzzing"

# Create a non-root user for the runtime process
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Install production + dev dependencies (tests run inside the container)
COPY package*.json ./
RUN npm ci

# Copy the rest of the application sources
COPY . .

RUN chown -R appuser:appgroup /app

USER appuser

EXPOSE 3000

CMD ["node", "server.js"]
