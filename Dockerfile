FROM oven/bun:slim 

RUN apt-get update && apt-get install -y tini && rm -rf /var/lib/apt/lists/*

ENTRYPOINT ["tini", "--"]

WORKDIR /app

COPY . .

RUN bun install --production

EXPOSE 3000

CMD ["bun", "index.ts"]
