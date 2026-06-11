FROM node:18-slim

# Install compilation tools for sqlite3 node module
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency manifests
COPY package*.json ./

# Install npm packages
RUN npm install --production

# Copy application source
COPY . .

# Create data volume and download directories
RUN mkdir -p /app/data && mkdir -p /app/downloads

# Expose the app port
EXPOSE 3005

# Define environment configuration
ENV PORT=3005
ENV NODE_ENV=production
ENV DATABASE_FILE=/app/data/tii_cache.db

# Run the startup script
CMD ["npm", "start"]
