# Respaldo privado y recuperaciÃ³n del piloto

Estos procedimientos son explÃ­citos: instalarlos no configura una tarea ni inicia
copias. No modifican la tarea antigua de producciÃ³n ni borran sus respaldos.

## Crear la copia en el ordenador

Ejecutar desde la raÃ­z de FORJA-WORKERS, tras revisar espacio local y confirmar el
destino privado autorizado. Elegir una operaciÃ³n nueva; no reutilizar carpetas.

```powershell
python scripts/pilot-backup.py --backup-root 'C:\Users\xsara\Desktop\Proyectos web\DiseÃ±ador web\forja-app\respaldos-locales' --operation 2026-11-21-piloto-pre-estabilizacion --include-image
```

El script comprueba la huella SSH fijada y exige `StrictHostKeyChecking=yes`.
Lee del contenedor efectivo y de `/opt/bot-llamadas-piloto/data`, comprueba el
montaje y confirma inactividad antes y despuÃ©s. Compara dos lecturas del estado
persistente y la identidad, imagen y arranque del contenedor. Si encuentra cambios,
falla y la operaciÃ³n incompleta no se utiliza para sustituir producciÃ³n.

La comprobaciÃ³n de estabilidad es observacional; no congela el sistema de archivos.
No ejecutar la copia mientras otras operaciones puedan iniciar llamadas o cambiar
configuraciÃ³n. Si no puede conseguirse una ventana estable, preparar una ventana
operativa autorizada antes de reintentar.

Incluye datos del piloto, configuraciÃ³n privada, `runtime.env`, descripciÃ³n privada
del contenedor y cÃ³digo real. SQLite se respalda mediante `backup()` hacia una
conexiÃ³n en memoria y `serialize()`, sin crear archivos remotos. Los ficheros WAL
no se copian por separado. La imagen Docker inmutable se transmite directamente
con `docker image save` a un archivo local; no se crea un tar en el servidor.

Los archivos privados nunca se muestran por stdout. La carpeta recibe ACL privada
en Windows; las copias quedan fuera de Git. Los archivos se verifican mediante
SHA-256. El tar de imagen se comprueba legible y su configuraciÃ³n coincide con el
ID inmutable. Si no se especifica `--include-image`, el manifiesto declara esa
exclusiÃ³n y no se considera suficiente para pÃ©rdida completa del servidor.

El respaldo no incluye sistema operativo del host, otros servicios, configuraciÃ³n
externa de la cuenta del operador ni sus registros de consumo.

## Ensayo local de restauraciÃ³n de archivos

```powershell
python scripts/pilot-restore-check.py 'C:\Users\xsara\Desktop\Proyectos web\DiseÃ±ador web\forja-app\respaldos-locales\2026-11-21-piloto-pre-estabilizacion'
```

Verifica todos los hashes antes de restaurar. Crea una carpeta privada nueva
`restore-isolated/original`, copia los archivos sin ejecutarlos y comprueba JSON y
`PRAGMA integrity_check` de SQLite. No inicia el cÃ³digo, contenedores, procesos de
telefonÃ­a ni conexiones externas. Otra carpeta `safe-runtime` contiene solamente
configuraciÃ³n vacÃ­a y la polÃ­tica de llamadas/WhatsApp desactivada, sin datos reales.

Este ensayo acredita recuperaciÃ³n de archivos y estructura SQLite, **no el arranque
completo de la aplicaciÃ³n ni recuperaciÃ³n telefÃ³nica extremo a extremo**. El
resultado lo declara explÃ­citamente. No sobrescribir un ensayo previo: conservarlo
y crear una nueva operaciÃ³n si es necesario.

## RecuperaciÃ³n operativa o pÃ©rdida del servidor

Requiere una operaciÃ³n separada autorizada. Preparar host compatible, verificar
manifiesto y archivo de imagen, cargar la imagen local y reconstruir la ejecuciÃ³n
a partir de `private/container-inspect.json`, revisando montajes, recursos, usuario,
red y puertos. Restaurar datos y entorno con permisos privados. No mostrar el
contenido de `container-inspect.json` ni `runtime.env` en informes.

El primer arranque de ensayo debe usar red `none`, sin puertos publicados, sin
credenciales activas y con `realCallsEnabled=false` y `realWhatsAppEnabled=false`.
El cÃ³digo antiguo del piloto no implementa necesariamente esa polÃ­tica: no confiar
solo en el archivo; el aislamiento de red y las credenciales eliminadas son
obligatorios. Usar datos sintÃ©ticos en las pruebas que ejecuten cÃ³digo.

No arrancar una segunda instancia con los mismos datos o credenciales SIP reales.
Una reversiÃ³n de aplicaciÃ³n conserva el estado de datos existente; restaurar una
base anterior es otra operaciÃ³n y puede perder operaciones posteriores. No declarar
restauraciÃ³n completa hasta verificar arranque, estado, persistencia y recorrido
telefÃ³nico mediante una llamada real expresamente autorizada.

## Pruebas del procedimiento

```powershell
python scripts/test-pilot-backup.py
```

La suite crea Ãºnicamente datos sintÃ©ticos privados temporales y no utiliza SSH,
Docker ni proveedores. Comprueba restauraciÃ³n SQLite, hashes alterados, rutas
inseguras, prohibiciÃ³n de sobrescritura e identidad de imagen de una fixture.

La exportación usa compresión SSH en tránsito (`ssh -C`), sin archivos remotos. `--image-timeout-seconds` permite de 60 a 86400 segundos y vale 7200 por defecto. El tamaño mostrado por Docker no equivale al tamaño del archivo exportado; este se conoce al terminar. Antes de exportar se guarda un manifiesto `incomplete` con hashes de los archivos ya recibidos; solo cambia a `complete` tras verificar la imagen solicitada. Ante interrupción se conserva la descarga parcial y no se usa esa operación para restaurar: el reintento crea otra subcarpeta.
