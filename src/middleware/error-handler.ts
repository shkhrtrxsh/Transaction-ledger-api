import type { ErrorRequestHandler, RequestHandler } from 'express';
import { config } from '../config';
import { AppError } from '../errors/app-error';

interface BodyParserError extends Error {
  type?: string;
  status?: number;
}

export const notFoundHandler: RequestHandler = (request, response) => {
  response.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `Route ${request.method} ${request.originalUrl} was not found`,
    },
  });
};

export const errorHandler: ErrorRequestHandler = (
  error,
  _request,
  response,
  next,
) => {
  if (response.headersSent) {
    next(error);
    return;
  }

  if (error instanceof AppError) {
    response.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    });
    return;
  }

  const bodyParserError = error as BodyParserError;

  if (bodyParserError.type === 'entity.parse.failed') {
    response.status(400).json({
      error: {
        code: 'INVALID_JSON',
        message: 'Request body contains malformed JSON',
      },
    });
    return;
  }

  if (bodyParserError.type === 'entity.too.large') {
    response.status(413).json({
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Request body is too large',
      },
    });
    return;
  }

  if (config.nodeEnv !== 'test') {
    console.error('Unhandled request error', error);
  }

  response.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    },
  });
};
