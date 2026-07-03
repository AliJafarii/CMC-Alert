import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const logger = new Logger("Bootstrap");
  const app = await NestFactory.createApplicationContext(AppModule);

  logger.log("CoinMarketCap polling bot started");

  process.on("SIGINT", async () => {
    logger.log("Shutting down...");
    await app.close();
    process.exit(0);
  });
}

void bootstrap();
