import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { DomainError } from '../work-orders/work-order.ops';

@Catch(DomainError)
export class DomainErrorFilter implements ExceptionFilter {
  catch(e: DomainError, host: ArgumentsHost) {
    host.switchToHttp().getResponse().status(e.status).json({ statusCode: e.status, message: e.message });
  }
}
