# FORJA-WORKERS

Servicios externos de llamadas, WhatsApp y panel CRM. Código TypeScript/Node.js
con centralita SIP en Python, separado de la app principal de Forja.

## Instalación y arranque seguro

Requisitos: Node.js 22 o posterior y npm. Python 3 para la centralita opcional.
Sus dependencias se instalan con `python -m pip install -r bridge/requirements.txt`.

```powershell
npm ci
Copy-Item .env.example .env
npm run build
npm test
```

Inicia cada servicio en una terminal diferente, desde la raíz del repositorio:

```powershell
npm run start:voice
npm run start:crm
npm run start:whatsapp
```

Panel local: http://127.0.0.1:3000/crm. Introduce la clave generada en
`data/control-token.txt` o usa «Seleccionar archivo de clave» en el acceso.
Los puertos locales son 3000 (panel), 8080 (audio) y 8089 (comunicación interna).

**Las llamadas y los envíos reales están bloqueados por defecto.** La ausencia
de `data/runtime-policy.json` mantiene ese bloqueo. Los botones del panel permiten
iniciar y pausar los workers sin contactar con nadie. No inicies la centralita
Python durante estas pruebas: su ejecución directa corresponde a telefonía real.

El repositorio incluye el modelo local `silero_vad.onnx`. No incluye credenciales,
sesiones de WhatsApp, contactos, grabaciones, colas operativas ni copias de seguridad.
La carpeta `data/` se genera localmente. Los audios de las pruebas históricas son
recursos locales y no se publican; `npm test` ejecuta la suite aislada de 33 pruebas.

## Estructura

- `src/voice-entry.ts`: proceso de voz.
- `src/crm-web-entry.ts`: panel y CRM.
- `src/whatsapp-entry.ts`: proceso propietario de WhatsApp.
- `src/runtime-policy.ts`: bloqueo persistente de comunicaciones.
- `public/`: interfaz del panel.
- `bridge/`: centralita SIP opcional.
- `brain/`: plantillas y configuración comercial sin credenciales.
- `scripts/`: pruebas y herramientas.

## Revisión de workers — 15/11/2026

### Acceso al panel

El servidor escucha en `127.0.0.1` por defecto. Al abrir el panel se solicita la
clave de `data/control-token.txt`, generada al iniciar el servidor. También puede
configurarse `WORKER_CONTROL_TOKEN` (mínimo 32 caracteres). No compartir esa clave
ni versionarla. La sesión del navegador dura ocho horas y usa cookie HttpOnly.
Los clientes de API deben enviar `Authorization: Bearer <clave>`; el WebSocket
también exige una sesión válida. Solo la visualización pública de propuestas
permanece accesible sin identificar al administrador.

### Procesos separados y pausa

En la ejecución separada, `start:crm` controla `start:whatsapp` mediante la
configuración persistida y una cola local de órdenes cerradas. La conexión,
desconexión y prueba manual del panel se ejecutan en el proceso propietario de
WhatsApp, sin abrir una segunda sesión Baileys en el CRM. La pausa impide nuevos
envíos; uno que ya haya comenzado puede terminar. El estado del panel distingue
trabajo en curso, pausa y ausencia de confirmación reciente del servicio.
Un consumidor no puede iniciar si otro proceso vivo es propietario de su cola.
No ejecutar simultáneamente el modo unificado y el separado sobre los mismos datos.

Detener llamadas espera el resultado del marcado pendiente y la confirmación del
colgado antes de liberar la reserva. Si el colgado falla, muestra parada pendiente
y bloquea nuevas llamadas hasta completar la parada.

### Datos, reintentos y muestras

Las escrituras CRM fusionan cambios independientes bajo bloqueo entre procesos;
una modificación incompatible del mismo campo devuelve un conflicto visible.
Las reservas de llamadas, cuotas y entregas de WhatsApp usan transacciones.
La sustitución atómica del archivo conserva el original ante fallos y reintenta
brevemente bloqueos transitorios de Windows.

Una desconexión, cuota agotada o muestra pendiente aplaza el trabajo con espera
creciente persistida; no consume el máximo de errores definitivos. Un envío con
resultado incierto queda aislado y requiere revisión manual: no se vuelve a enviar
automáticamente. No se han reencolado trabajos antiguos de `failed` o `uncertain`.

El mensaje usa la plantilla del proyecto y una propuesta persistida que coincide
con el negocio y su token. Requiere URL HTTPS pública; no inventa ni sustituye la
muestra por un enlace genérico. Si falta la propuesta o la autorización, espera.
La generación de la propuesta sigue siendo una operación independiente.

### Pruebas sin comunicaciones reales

Ejecutar `npm run check` y `npm run test:workers`.
La suite de workers usa directorios temporales nuevos, carga el código TypeScript
real y sustituye exclusivamente los transportes y dependencias periféricas del
ensayo. Bloquea red, arranque de telefonía y acceso a datos fuera del directorio
temporal. Incluye cuatro procesos Node escribiendo simultáneamente, recuperación
de cola, controles HTTP/WebSocket, autenticación del panel y conexión/desconexión
de WhatsApp simulada. No lee las credenciales SIP o Baileys de uso real.

No ejecutar las suites históricas que limpian `data/` contra el directorio de
operación; la nueva suite `test:workers` prepara su propio entorno aislado.
Las pruebas simuladas no certifican cobertura de telefonía ni entrega en los
proveedores reales. Aplicar código no equivale a arrancar o reiniciar los servicios.


### Arranque seguro sin comunicaciones reales

`data/runtime-policy.json` controla `realCallsEnabled` y `realWhatsAppEnabled`.
Si falta, está dañado o sus valores no son explícitamente `true`, las comunicaciones
permanecen bloqueadas. El panel no tiene una ruta para levantar este bloqueo.
En modo seguro los botones arrancan y pausan los bucles de control, pero las colas
no se consumen y no se abre la centralita ni la conexión con WhatsApp. El transporte
también comprueba el bloqueo antes de marcar o enviar, incluidos los envíos manuales.
El panel muestra un aviso visible. La activación real exige una decisión independiente.
