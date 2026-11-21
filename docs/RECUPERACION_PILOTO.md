# Respaldo privado y recuperación del piloto

Estos procedimientos son explícitos: instalarlos no configura una tarea ni inicia
copias. No modifican la tarea antigua de producción ni borran sus respaldos.

## Crear la copia en el ordenador

Ejecutar desde la raíz de FORJA-WORKERS, tras revisar espacio local y confirmar el
destino privado autorizado. Elegir una operación nueva; no reutilizar carpetas.

```powershell
python scripts/pilot-backup.py --backup-root 'C:\Users\xsara\Desktop\Proyectos web\Diseñador web\forja-app\respaldos-locales' --operation 2026-11-21-piloto-pre-estabilizacion --include-image
```

El script comprueba la huella SSH fijada y exige `StrictHostKeyChecking=yes`.
Lee del contenedor efectivo y de `/opt/bot-llamadas-piloto/data`, comprueba el
montaje y confirma inactividad antes y después. Compara dos lecturas del estado
persistente y la identidad, imagen y arranque del contenedor. Si encuentra cambios,
falla y la operación incompleta no se utiliza para sustituir producción.

La comprobación de estabilidad es observacional; no congela el sistema de archivos.
No ejecutar la copia mientras otras operaciones puedan iniciar llamadas o cambiar
configuración. Si no puede conseguirse una ventana estable, preparar una ventana
operativa autorizada antes de reintentar.

Incluye datos del piloto, configuración privada, `runtime.env`, descripción privada
del contenedor y código real. SQLite se respalda mediante `backup()` hacia una
conexión en memoria y `serialize()`, sin crear archivos remotos. Los ficheros WAL
no se copian por separado. La imagen Docker inmutable se transmite directamente
con `docker image save` a un archivo local; no se crea un tar en el servidor.

Los archivos privados nunca se muestran por stdout. La carpeta recibe ACL privada
en Windows; las copias quedan fuera de Git. Los archivos se verifican mediante
SHA-256. El tar de imagen se comprueba legible y su configuración coincide con el
ID inmutable. Si no se especifica `--include-image`, el manifiesto declara esa
exclusión y no se considera suficiente para pérdida completa del servidor.

El respaldo no incluye sistema operativo del host, otros servicios, configuración
externa de la cuenta del operador ni sus registros de consumo.

## Ensayo local de restauración de archivos

```powershell
python scripts/pilot-restore-check.py 'C:\Users\xsara\Desktop\Proyectos web\Diseñador web\forja-app\respaldos-locales\2026-11-21-piloto-pre-estabilizacion'
```

Verifica todos los hashes antes de restaurar. Crea una carpeta privada nueva
`restore-isolated/original`, copia los archivos sin ejecutarlos y comprueba JSON y
`PRAGMA integrity_check` de SQLite. No inicia el código, contenedores, procesos de
telefonía ni conexiones externas. Otra carpeta `safe-runtime` contiene solamente
configuración vacía y la política de llamadas/WhatsApp desactivada, sin datos reales.

Este ensayo acredita recuperación de archivos y estructura SQLite, **no el arranque
completo de la aplicación ni recuperación telefónica extremo a extremo**. El
resultado lo declara explícitamente. No sobrescribir un ensayo previo: conservarlo
y crear una nueva operación si es necesario.

## Recuperación operativa o pérdida del servidor

Requiere una operación separada autorizada. Preparar host compatible, verificar
manifiesto y archivo de imagen, cargar la imagen local y reconstruir la ejecución
a partir de `private/container-inspect.json`, revisando montajes, recursos, usuario,
red y puertos. Restaurar datos y entorno con permisos privados. No mostrar el
contenido de `container-inspect.json` ni `runtime.env` en informes.

El primer arranque de ensayo debe usar red `none`, sin puertos publicados, sin
credenciales activas y con `realCallsEnabled=false` y `realWhatsAppEnabled=false`.
El código antiguo del piloto no implementa necesariamente esa política: no confiar
solo en el archivo; el aislamiento de red y las credenciales eliminadas son
obligatorios. Usar datos sintéticos en las pruebas que ejecuten código.

No arrancar una segunda instancia con los mismos datos o credenciales SIP reales.
Una reversión de aplicación conserva el estado de datos existente; restaurar una
base anterior es otra operación y puede perder operaciones posteriores. No declarar
restauración completa hasta verificar arranque, estado, persistencia y recorrido
telefónico mediante una llamada real expresamente autorizada.

## Pruebas del procedimiento

```powershell
npm run test:backup
```

La suite crea únicamente datos sintéticos privados temporales y no utiliza SSH,
Docker ni proveedores. Comprueba restauración SQLite, hashes alterados, rutas
inseguras, prohibición de sobrescritura e identidad de imagen de una fixture.

La exportación usa compresión SSH en tránsito (`ssh -C`), sin archivos remotos. `--image-timeout-seconds` permite de 60 a 86400 segundos y vale 7200 por defecto. El tamaño mostrado por Docker no equivale al tamaño del archivo exportado; este se conoce al terminar. Antes de exportar se guarda un manifiesto `incomplete` con hashes de los archivos ya recibidos; solo cambia a `complete` tras verificar la imagen solicitada. Ante interrupción se conserva la descarga parcial y no se usa esa operación para restaurar: el reintento crea otra subcarpeta.


### Identidad OCI y Docker clásico

`image-archive-verifier.py` es el verificador común de backup y restauración. Un ID Docker puede identificar la configuración de una imagen clásica o un índice OCI. En OCI se exige una cadena íntegra desde el digest inmutable esperado al manifiesto de plataforma, configuración exacta y capas del `manifest.json` exportado. Se verifican tamaño y SHA-256 de todos los blobs referenciados, incluidas attestations y su subject, y después los `rootfs.diff_ids` de las capas descomprimidas. Una configuración válida pero no vinculada al índice esperado se rechaza. No se descargan blobs externos ni se extraen rutas del tar.

El manifiesto distingue `image.imageId` (identidad original) e `image.identity.configDigest`; verificar el archivo no equivale a ensayar una aplicación completa. Si Docker local materializa el config digest en lugar del index digest, un ensayo solo puede aceptar ese config digest ya verificado, con `inspect.RootFS.Layers` exactamente iguales a los diff_ids comprobados y el mismo sistema operativo/arquitectura. Registrar por separado `sourceImageId` y `loadedImageId`; nunca afirmar que ambos IDs son iguales cuando Docker los representa de forma distinta. Las capas zstd se rechazan explícitamente mientras no exista soporte probado; gzip y capas sin compresión están cubiertas.

### Resultado operativo del 21/11/2026

Se verificó la captura original de 00:32:37 UTC: 69 archivos y una imagen de
913720320 bytes. La identidad OCI quedó enlazada y comprobada mediante 23 blobs
y 17 capas. SHA-256 del archivo: `80d81a2e01ae0b06fea07dad4c8bdfd158b5e14aa577a9e6cf1049e228499d01`.

El ensayo local cargó esa imagen y el código recuperado, sin red ni puertos, con
configuración y datos sintéticos. Arranque y reinicio correctos; persistencia,
integridad SQLite e incertidumbre conservadas; sin registro SIP ni proveedor de
voz. Se retiró únicamente el contenedor propio del ensayo. Las copias históricas
se conservaron. No demuestra recuperación telefónica real ni actualiza la fecha
de los datos respaldados. Evidencia privada: `respaldos-locales/2026-11-21-piloto-ensayo-restauracion-segunda/result.json` en el ordenador del propietario.
