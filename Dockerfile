FROM node:22-slim

# Install compilation tools if needed for native packages
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 3005
ENV PORT=3005
ENV NODE_ENV=production

CMD ["npm", "start"]
