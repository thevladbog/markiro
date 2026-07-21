import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { apiReference } from "@scalar/nestjs-api-reference";
import { AppModule } from "./app.module";
import { loadEnv } from "./env";

async function bootstrap() {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule);
  const doc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle("Markiro API").setVersion("0.1").build(),
  );
  app.use("/openapi.json", (_req: unknown, res: { json(b: unknown): void }) => res.json(doc));
  app.use("/docs", apiReference({ content: doc }));
  await app.listen(env.PORT);
}
void bootstrap();
