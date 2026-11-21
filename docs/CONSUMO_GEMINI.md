# Consumo Gemini en el piloto

Revisión documental: 21/11/2026. No se han hecho peticiones de pago.

La referencia de Live describe `totalTokenCount` por petición de generación, no
como un acumulado garantizado de toda la sesión. Incluye contadores de entrada,
respuesta, caché, pensamiento y herramientas, y desgloses por modalidad. No se
deben sumar indiscriminadamente muestras ni aplicar una tarifa de texto al audio.
[Referencia oficial Live](https://aistudio.google.com/api-reference/live#UsageMetadata).

El SDK oficial distingue `promptTokensDetails`, `responseTokensDetails`,
`cacheTokensDetails` y `toolUsePromptTokensDetails`. El contador de entrada incluye
la parte de caché; no se suma esa parte otra vez.
[Tipos oficiales de UsageMetadata](https://googleapis.github.io/js-genai/release_docs/interfaces/types.UsageMetadata.html).

## Contrato implementado

- El motor conserva únicamente campos numéricos y desgloses de uso conocidos:
  no prompts, audio, claves, transcripciones o campos arbitrarios del proveedor.
  Retiene como máximo 64 observaciones, con secuencia local y turno.
- Un informe asociado al mismo mensaje que `turnComplete` se contabiliza para
  ese turno. Turnos distintos se suman; repetir el mismo identificador de turno
  sustituye la muestra y no lo duplica. Una muestra sin asociación confirmada
  queda pendiente y no se presenta como coste completo.
- La asociación conservadora es una decisión de este adaptador: no se supone una
  ordenación entre mensajes que la API no garantice. Los informes que llegan
  separados del cierre requieren conciliación posterior. La guía confirma que
  se reciben mensajes periódicos con metadata, pero no garantiza una factura
  completa por sesión. [Guía oficial de tokens](https://aistudio.google.com/docs/live-api/capabilities#token-count).
- Una tarifa local exige modelo, versión y precios separados de entrada/salida
  para TEXT y AUDIO, expresados en microUSD por millón de tokens. Se calcula con
  enteros y redondeo al alza. No se incluyen precios comerciales o tarifas reales
  predeterminadas. La tarifa debe coincidir con el modelo configurado.
- Si falta desglose, no concuerda con los contadores o aparecen caché,
  pensamientos o herramientas, `estimatedMicroUsd` es null. Esos conceptos no
  se ignoran para fabricar un total. `actualMicroUsd` permanece null hasta una
  conciliación independiente con cargos del proveedor.

## Presupuesto y límites

Cada prueba reserva 100.000 microUSD de presupuesto administrativo; se permiten
tres reservas por día empresarial, separadas al menos 60 segundos, una sola
prueba en curso y 15 segundos máximos de comprobación. Son límites internos,
no una tarifa ni una garantía de factura externa de 0,10 USD.

La reserva no se libera automáticamente usando una estimación menor o un coste
desconocido. Si el cierre no se confirma, queda pendiente y bloquea nuevas pruebas
incluso tras reiniciar. Si una estimación observada supera lo reservado, el
presupuesto siguiente utiliza el valor mayor. Un fallo de configuración anterior
al proveedor libera el bloqueo de ejecución y no consume reserva.

Las pruebas pagadas requieren runtime-policy habilitada, autenticación privada y
tarifa versionada. El cierre del WebSocket se espera durante un plazo acotado.
El gasto puede notificarse tarde: estos controles no son un límite de facturación
impuesto por Google. Para habilitar uso real deben configurarse además límites de
cuenta/proveedor y validarse con el modelo contratado. Una prueba interrumpida
puede no proporcionar su uso final; no se inventa ni se marca como coste cero.

## Pruebas aisladas

`scripts/test-pilot-safe.cjs` cubre TTL, modificación de configuración, error de
carga, error de cierre, concurrencia, cuota durable, reserva incierta, corrupción,
informes por turno, repetición del mismo turno, tarifas por modalidad, datos
incompletos y retención acotada. `scripts/test-pilot-http-safe.cjs` comprueba en
loopback autenticación, cookie, origen y salud sin conectar SIP ni proveedores.

## Apagado del piloto

Configurar Docker stop_grace_period de al menos 180 segundos. SIGTERM bloquea nuevas llamadas y pruebas, persiste incertidumbre y solicita colgado. Sin confirmacion de colgado y observacion positiva de linea libre, conserva el controlador SIP y la API de diagnostico; otra senal permite reintentar. Un SIGKILL o la perdida del host no admite garantias: el limite remoto del operador sigue pendiente de verificar.
