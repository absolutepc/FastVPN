import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  app.enableCors({
    origin: true,
    credentials: true,
  });

  // Mini App static files → /app
  app.useStaticAssets(join(__dirname, '..', 'webapp'), {
    prefix: '/app/',
  });

  const port = process.env.PORT || 3000;
  await app.listen(port);

  console.log(`4StepsVPN started on port ${port}`);
  console.log(`Mini App: http://localhost:${port}/app/`);
}

bootstrap();
