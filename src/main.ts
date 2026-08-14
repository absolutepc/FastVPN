import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  const allowedOrigin = new URL(
    process.env.APP_URL || 'https://4stepsvpn.ru',
  ).origin;

  app.enableCors({
    origin: allowedOrigin,
    credentials: true,
  });

  app.disable('x-powered-by');

  // Mini App static files → /app
  app.useStaticAssets(join(__dirname, '..', 'webapp'), {
    prefix: '/app/',
  });

  const port = process.env.PORT || 3000;
  await app.listen(port, '127.0.0.1');

  console.log(`4StepsVPN started on port ${port}`);
  console.log(`Mini App: http://localhost:${port}/app/`);
}

bootstrap();
