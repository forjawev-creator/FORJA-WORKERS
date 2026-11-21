# Estabilización del piloto — 21/11/2026

Base versionada b724085 y contraste con el código ejecutado en bot-llamadas-piloto.
Se conserva el circuito SIP/RTP y Gemini existente; no se reemplaza producción.

| Hallazgo | Corrección | Evidencia automatizada |
| --- | --- | --- |
| H1 | Copia directa al ordenador del volumen real, configuración, código e imagen inmutable; hashes y restauración aislada | test-pilot-backup.py; ensayo operativo separado |
| H2 | Salud por componentes y supervisión limitada; nunca recuperar con llamada activa o estado incierto | test-bridge-supervisor.ts; test-pilot-http-safe.cjs |
| H3 | Caducidad de comprobación, invalidación por configuración/error | test-pilot-safe.cjs |
| H4 | Registro SIP con vigencia y correlación de transacción | test-bridge-stabilization.py |
| H5 | Presupuesto durable de pruebas, concurrencia, cuotas y uso por modalidad | test-pilot-safe.cjs; CONSUMO_GEMINI.md |
| H6 | Limpieza de ejecución ante configuración inválida sin ocultar error | test-pilot-safe.cjs |
| H7 | RTP enviado, recibido y errores por llamada y acumulados | test-bridge-stabilization.py |

Validación local: build y 86 comprobaciones (33 workers, 26 piloto/ciclo/consentimiento,
10 puente, 4 privacidad de logs, 6 supervisor y 7 respaldo). No consumen telefonía
ni proveedor de voz. No equivalen a una llamada real autorizada.

También se recuperan protecciones presentes en el desplegado y ausentes del
repositorio: consentimiento comprobado, finalización correlacionada, conservación
de incertidumbre, persistencia visible y prohibición del canal UDP de órdenes.
Transcripciones apagadas por defecto; la autorización local y por llamada son
necesarias para conservarlas. Las transcripciones históricas no se eliminan.

La tarea programada antigua sigue sin modificarse: requiere una operación
administrativa específica. El nuevo procedimiento H1 sustituye su uso para este
piloto, no afirma haber corregido el temporizador productivo. Ver RECUPERACION_PILOTO.md.
La recuperación operativa debe documentarse con su resultado real; las pruebas
del script no certifican una restauración completa de telefonía.

La instancia de referencia del servidor debe usar datos sintéticos, secretos nuevos,
red Docker interna, panel solo en loopback y comunicaciones deshabilitadas. Es una
instalación ejecutable separada, no un archivo de respaldo remoto. El piloto activo
se conserva. La imagen Docker base se suministra por identificador inmutable
verificado; no se publica esa imagen ni sus dependencias fuera del servidor.

Pendientes externos: activación pública, prueba telefónica de pago y sustitución
del piloto requieren autorización expresa. No se afirma disponibilidad real por
tener el panel accesible o pasar estas comprobaciones.
