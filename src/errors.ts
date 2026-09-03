export interface SerializableError {
  name: string;
  message: string;
}

export function toSerializableError(error: unknown): SerializableError {
  if (error instanceof Error || error instanceof DOMException) {
    return {
      name: error.name,
      message: error.message,
    };
  }

  return {
    name: "UnknownError",
    message: String(error),
  };
}

export function errorMessage(error: unknown): string {
  const serializable = toSerializableError(error);
  return `${serializable.name}: ${serializable.message}`;
}
