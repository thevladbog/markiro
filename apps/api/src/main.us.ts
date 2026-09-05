import "reflect-metadata";
import { createUsDevelopmentApplication } from "./deployment/us-bootstrap";

async function bootstrapUs() {
  const app = await createUsDevelopmentApplication(process.env);
  try {
    await app.listen(3100, "127.0.0.1");
  } catch (error) {
    await app.close();
    throw error;
  }
}

void bootstrapUs().catch(() => {
  console.error(
    "US development API startup refused. Check the isolated local environment and port 3100.",
  );
  process.exitCode = 1;
});
