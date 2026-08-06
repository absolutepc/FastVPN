import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // HTTP нужен для webhook ЮKassa и subscription endpoint
  const port = process.env.PORT || 3000;
  await app.listen(port);

  console.log(`Access One started on port ${port}`);
}

bootstrap();
