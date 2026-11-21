# Telefonía entrante — decisión y contrato de enrutamiento

Revisión documental: 21/11/2026. No se han realizado llamadas, compras, cambios de
numeración ni conexiones autenticadas a Netelip o LiveKit para esta investigación.

## Decisión para el primer piloto

Mantener Netelip y reutilizar el puente SIP/RTP y el motor Gemini, con una sola
sesión simultánea. No incorporar LiveKit todavía. Es una decisión de desarrollo
basada en la infraestructura existente; no acredita que la ruta entrante real
esté configurada ni que Netelip conserve todos los identificadores esperados.

Las siguientes decisiones son independientes:

| Dimensión | Alternativas | Decisión inicial y condición de revisión |
| --- | --- | --- |
| Conexión del operador | Línea SIP registrada; SIP Trunk por IP | Ensayar la línea existente con destino E.164 verificable. Evaluar trunk cuando la asignación de números/canales o fiabilidad lo exijan. |
| Gestión de sesiones y audio | Puente propio; gateway SIP/LiveKit | Reutilizar puente actual con capacidad 1; comparar alternativa antes de permitir concurrencia real. |
| Proveedor de voz | Gemini actual; otros adaptadores futuros | Mantener Gemini y medir; no cambiarlo por una suposición de calidad. |

Netelip documenta enrutamiento de números a línea SIP, servidor SIP y otros
destinos. Una línea SIP requiere registro del dispositivo. La alternativa de
servidor SIP entrega a IP o dominio configurado; no es una demostración de
compatibilidad de nuestra instalación. [Enrutamiento de numeración](https://www.netelip.com/centro-de-ayuda/numeros-virtuales/configuracion-del-servicio/).

El servicio de trunk de Netelip utiliza autenticación por IP y publica capacidad
de canales y codecs, incluido G.711a. No se contratará ni se asumirá que esa
capacidad está disponible en la cuenta actual. [Servicio SIP Trunking](https://www.netelip.com/sip-trunk-enruta-las-llamadas-de-tu-pbx/).

## Comparación técnica a validar

| Aspecto | Puente existente | Alternativa LiveKit |
| --- | --- | --- |
| Latencia | Conserva el trayecto y conversión de audio actuales; requiere medidas reales | Introduce otro componente de media; no se afirma mayor ni menor latencia sin medir |
| Audio e interrupciones | Reutiliza PCMA, RTP y vaciado de turnos; probar audio audible | Requiere adaptar eventos y comprobar comportamiento de interrupción extremo a extremo |
| Concurrencia | El objeto del puente mantiene una llamada; no es seguro abrir varias sin refactorizar | Ofrece reglas de despacho a salas; sigue siendo necesario aislar herramientas, presupuesto y empresa |
| Operación | Menos servicios nuevos; mantenemos código SIP propio | Añade servicio, configuración, observabilidad y coste a valorar |
| Coste | Telefonía + IA + recursos existentes; medir por sesión | Añadir coste de media/infraestructura aplicable; no se han fijado tarifas |

LiveKit requiere trunk entrante y regla de despacho para recibir desde un operador
externo. Permite restringir el origen y admite autenticación por usuario/contraseña
cuando también la soporta el operador; no se presupone esa capacidad en Netelip.
[Trunks entrantes LiveKit](https://docs.livekit.io/telephony/accepting-calls/inbound-trunk/).

Si se adopta LiveKit, cada llamada debe usar una sala distinta y opaca. No usar una
sala común por empresa ni desactivar aleatoriedad con el teléfono como nombre:
sus reglas pueden reunir llamadas y los nombres de sala pueden exponer números
en logs. Restringir reglas a trunks concretos. [Reglas de despacho](https://docs.livekit.io/telephony/accepting-calls/dispatch-rule/).

## Qué sabemos del destino, y qué falta verificar

Netelip documenta la opción «Contacto e164» para entregar el número llamado en la
Request-URI del INVITE. La identidad mostrada al terminal y el tratamiento de
desvíos pueden variar con la configuración; no se usará esa identidad para
autenticar al llamante. [Asignación de numeración](https://www.netelip.com/centro-de-ayuda/centralita-virtual/configuracion-del-servicio/asignar-numeracion/).

La documentación del trunk indica entrega entrante en formato internacional.
También describe restricciones de IP y puerto. Sus hosts de trunk no deben
intercambiarse automáticamente con el servidor de la línea registrada actual.
[Preguntas frecuentes del trunk](https://www.netelip.com/centro-de-ayuda/sip-trunking/preguntas-frecuentes/).

La API Cloud documenta consulta, configuración y compra de numeración, incluidos
campos de contacto E.164 y destino SIP. Su acceso requiere token y habilitación de
la IP con Netelip. Documentación disponible no significa permisos de cuenta ya
concedidos ni autoriza una compra. [API Cloud oficial](https://apidoc.netelip.com/v1/apicloud/).

Pendiente de confirmación del proveedor y de una llamada autorizada: Request-URI
exacta que recibirá esta cuenta, peers autorizados y puertos, dominio/puerto de
destino, número virtual asignado, ruta directa y desviada, tratamiento de identidad
oculta y cabeceras de desvío, señalización de fin y comportamiento de errores.
No se ha verificado preservación de `Diversion` o `History-Info` para este caso.

El primer diseño asigna un número virtual diferente a cada instalación. Así no
necesita deducir la empresa a partir del móvil original que hizo el desvío. Si se
pretende compartir un número entre empresas, hace falta otra ruta verificada;
no se implementará una inferencia desde el número del llamante.

## Contrato implementado, todavía no conectado al piloto

`bridge/inbound_routing.py` es un módulo puro: no escucha puertos, no contesta
llamadas, no inicia motores ni ejecuta herramientas. Por defecto rechaza todo.

La política procede del backend/control administrativo, nunca de una petición
telefónica. Contiene listener y perfil de proveedor, pares IP/puerto exactos,
hosts de Request-URI permitidos, evidencia vigente de revisión de red y asociación
verificada/vigente de número a instalación activa. Rechaza asociaciones duplicadas.

El adaptador debe proporcionar IP/puerto del socket receptor, nunca `X-Forwarded-*`
ni metadatos elegidos por el llamante. El módulo exige INVITE bien formado, destino
internacional de Request-URI y host permitido, Call-ID/CSeq sin ambigüedad y mapeo
vigente. No consulta `From`, `To`, `Diversion` ni `X-Installation-ID` para elegir
empresa. No hay destino de reserva ni conversión de números locales inventando país.

Devuelve instalación, destino y una clave estable de diálogo para deduplicar
retransmisiones. Declara `caller_authenticated=false` y `trust_scope=routing_only`:
identificar la empresa receptora no autentica al interlocutor.

La allowlist IP es una restricción de red, no autenticación criptográfica de una
persona. Antes de habilitar UDP deben validarse firewall, topología y procedencia
con el operador; si la garantía es insuficiente, usar un gateway autenticado que
mantenga ese límite de confianza. No debe exponerse este contrato como una API que
acepte políticas o peers enviados por el cliente.

El routing por sí solo no realiza los controles del controlador: verificar plan,
módulos y activación en backend; reservar capacidad/presupuesto atómicamente;
gestionar retransmisiones/re-INVITE; crear sesión independiente; limitar herramientas
de cliente externo y confirmar resultados. El servicio descrito al final incorpora
esos controles; el módulo puro no los sustituye.

## Pruebas y autorización pendiente

`python scripts/test-inbound-routing.py`: 12 pruebas puras de bloqueo por defecto,
dos instalaciones, retransmisiones, peers/listeners, cabeceras maliciosas, destinos
desconocidos, URI malformada, asociaciones duplicadas, ambigüedad de Call-ID/CSeq,
vigencia, suspensión y errores sin datos privados.

No se ha conectado el módulo al puente productivo. El piloto existente continúa
rechazando entrantes y la instancia nueva debe permanecer con llamadas bloqueadas.
Antes de una prueba real: validar ruta de un número, autorizar expresamente recepción
y gasto, limitar capacidad a 1, duración y presupuesto, y comprobar audio, latencia,
interrupciones, colgado, persistencia y consumo. No se ha declarado superada esa
prueba ni la integración Netelip–LiveKit.


## Implementación del servicio entrante (sin activación real)

El entrypoint separado `npm run start:inbound` utiliza `dist/inbound-entry.js`; el piloto saliente mantiene su entrypoint anterior. Se requiere simultáneamente `TELEPHONY_MODE=inbound_secretaria`, `INBOUND_ENABLED=true`, `CALLS_PILOT` distinto de `1` y la política privada `realCallsEnabled:true`. Su ausencia bloquea el registro SIP y las admisiones. **Estos requisitos describen una activación futura autorizada; las pruebas no los activan en el servidor.**

Configuración privada, fuera de Git/paquetes: `INBOUND_CONTROL_TOKEN` (base64url 43–128 caracteres), `INBOUND_SOURCE`, `INBOUND_SOURCE_SECRET`, `INBOUND_CENTRAL_ORIGIN`, `INBOUND_BACKEND_ORIGINS` (orígenes HTTPS exactos separados por comas), credenciales SIP/Gemini existentes y tarifa versionada `data/gemini-probe-rates.json`. El modelo configurado debe coincidir con la tarifa. No se inventa una tarifa ni se convierte USD a EUR. El límite local de IA estimado es 100000 microUSD por llamada; la duración máxima es 120 segundos y la reserva económica del backend permanece pendiente de conciliación real.

Ese límite local no garantiza un tope de factura del proveedor: las métricas pueden
llegar tarde o incompletas. Los controles de cuenta y la conciliación siguen siendo
necesarios. La duración observada no se recorta al límite de admisión ni incluye
el tiempo de reintentos del backend tras el cierre SIP confirmado.

Los bloqueos de escritura del almacenamiento general solo se adquieren de forma
exclusiva. En Windows se reintentan brevemente errores transitorios de compartición;
un fallo persistente conserva su error original. Un archivo de bloqueo aparentemente
huérfano requiere revisión manual, porque borrarlo a partir de un PID leído antes
puede eliminar el bloqueo nuevo de otro proceso. No borrarlo con escritores activos.

`data/inbound-routing.json` contiene los campos de `InboundPolicy`, bindings verificados y `media_peers` (IPs RTP exactas verificadas). No se admite una dirección de medios arbitraria del SDP. Configuración sin verificación vigente, mapeo desconocido, puerto/IP SIP diferente, SDP distinto de PCMA o configuración incompleta → rechazo. No se interpreta `From`, callerID, `Diversion` ni cabeceras `X-*` como autorización. Las operaciones no reciben un tenant del modelo.

Recorrido implementado:

1. INVITE validado y capacidad local reservada; respuesta 180.
2. TCP local autenticado y preflight HTTP `127.0.0.1:8087/prepare`. El worker consulta el resolvedor, verifica origen backend contra allowlist y persiste capability/evento antes de admitir.
3. El backend reserva sesión/cupo/presupuesto. El motor configura únicamente la secretaría y herramientas autorizadas. Solo entonces se envía 200.
4. ACK válido y correlacionado inicia saludo identificando empresa y asistente virtual. RTP PCMA solo desde el peer y puerto SDP verificados y tras ACK.
5. Herramientas idempotentes persistidas antes del envío, sin transcripción persistida ni herramientas de WhatsApp o ventas. Solo una llamada global, aunque haya múltiples empresas configuradas.
6. Despedida o límite solicitan BYE; no se libera capacidad hasta confirmación terminal y cierre confirmado del motor/backend. BYE sin confirmar, respuesta perdida, fallo de disco o reinicio conservan incertidumbre y bloquean nuevas admisiones.

`data/inbound-journal.json` es privado: contiene capacidades y datos estructurados necesarios para conciliar operaciones pendientes. Las capacidades/cargas de operaciones se eliminan del registro al confirmar el cierre. No debe publicarse, incluirse en imágenes ni abrirse a otros usuarios. La carpeta de datos requiere permisos privados del usuario de servicio (0700 y archivos 0600 en Linux; ACL equivalente en Windows).

Tras reinicio no se inicia automáticamente el puente si hay una sesión incierta. Un operador debe confirmar primero el estado SIP real, enviar la evidencia terminal al control local autenticado `/terminal` y, si hubo una respuesta de admisión perdida, repetir `/reconcile` con el mismo `dialogKey`. El reintento utiliza los eventos/capability originales, incluso si la sesión expiró, únicamente para cerrarla. Servicio suspendido/módulo apagado puede impedir la conciliación worker; el backend conserva el caso para administración auditada. No borrar el journal para desatascar capacidad.

Validación automatizada: `npm run test:inbound` cubre routing, SIP sintético, tiempos/cancelación, capacidades, idempotencia, aislamiento entre instalaciones, recuperación incierta, cierre del proveedor, códec/interrupción y el recorrido completo con HTTP/TCP reales de loopback. `scripts/inbound-sip-fixture.py` no abre sockets SIP/RTP: representa esos mensajes como objetos y usa un motor simulado; ninguna prueba paga LLM ni llama a un número. La compatibilidad de señalización y audio real de Netelip continúa pendiente de una llamada expresamente autorizada.
