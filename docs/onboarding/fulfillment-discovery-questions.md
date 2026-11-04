# Onboarding: preguntas para armar el proceso de pedidos de una empresa

Para usar en el discovery / onboarding de cada empresa nueva. Las respuestas
definen sus estados, interruptores y ramas en Nellio (ver
`docs/superpowers/specs/2026-11-04-order-fulfillment-e2e-design.md`, §4, §11).

Cómo usarla: mejor que la respuesta en abstracto es pedirles que cuenten **un
pedido real reciente**, de principio a fin, y quién lo tocó en cada momento.
Las preguntas sirven para llenar los huecos de ese relato.

Cada pregunta indica entre corchetes qué define en Nellio.

---

## 0. Para abrir

1. Cuéntenme el último pedido que entregaron: desde que el cliente lo pidió
   hasta que lo recibió. ¿Quién lo tocó en cada paso?
2. ¿Qué parte del día a día les quita más tiempo o les genera más problemas?
3. ¿Qué usan hoy para llevar los pedidos (Excel, cuaderno, sistema, solo
   WhatsApp)?

## 1. Cómo llegan los pedidos

4. ¿Por dónde les piden los clientes (WhatsApp, teléfono, correo, formulario
   web, vendedores en la calle)? ¿Cuál es el más común?
   [canales]
5. ¿Quién pasa el pedido a su sistema y cuánto tarda?
   [quién captura]
6. ¿Cotizan antes de cada pedido, solo a clientes nuevos o nunca? Si
   cotizan: ¿el cliente aprueba la cotización por escrito?
   [estados propios en "Por confirmar"]
7. ¿Algún pedido necesita una aprobación antes de confirmarse (crédito,
   pago adelantado, visto bueno de un gerente)?
   [estados propios en "Por confirmar"]

## 2. Bodega y preparación

8. ¿Quién prepara y carga el pedido? ¿Es la misma persona que lo confirma?
   [paso "Listo en bodega" sí/no]
9. ¿Alguien revisa que el pedido esté completo antes de que salga? ¿Quién?
   [estados propios en "En preparación"]
10. ¿Hasta qué momento se puede cambiar un pedido (productos, cantidades,
    precios)? ¿Pasa que lo cambian cuando ya salió?
    [bloqueo de edición]

## 3. Choferes y envío

11. ¿Entregan con camiones propios, con paquetería o de las dos formas?
    [quién confirma la entrega: chofer u oficina]
12. ¿Cuántos choferes tienen? ¿Cada uno tendría su propio celular y su
    propia cuenta, o comparten?
    [cuentas de chofer]
13. ¿El chofer tiene que aceptar el pedido antes de salir, o se le asigna y
    ya?
    [`require_driver_acceptance`]
14. Si un chofer no puede llevar un pedido, ¿qué pasa hoy? ¿Quién lo
    reasigna?
    [rama "chofer rechaza"]
15. ¿Un chofer lleva varios pedidos en un mismo viaje? ¿Importa el orden de
    las paradas?
    [rutas: fuera de alcance si no importa]
16. ¿Le dan al cliente una fecha o franja de entrega ("mañana de 8 a 12")?
    ¿Son franjas fijas o libres?
    [ventana de entrega / hora estimada]

## 4. Entrega

17. ¿Qué firma o entrega el cliente al recibir (firma en papel, sello,
    nombre)? ¿Les serviría que firme en el celular del chofer?
    [`require_signature`, `require_receiver_name`]
18. ¿Toman foto de la entrega? ¿Debería ser obligatoria?
    [`require_photo`]
19. ¿Hay zonas donde el chofer se queda sin señal?
    [fase "sin señal"]
20. Si el cliente no está, está cerrado o rechaza el pedido: ¿qué hacen?
    ¿Reintentan otro día, vuelve a bodega, se cancela? ¿Cuántas veces
    reintentan?
    [rama "entrega fallida"]
21. Si el cliente recibe solo una parte (falta producto, viene dañado,
    rechaza una línea): ¿cómo lo registran hoy? ¿Se le manda lo que faltó
    después?
    [rama "entrega parcial"]
22. ¿Cuáles son los motivos más comunes por los que una entrega falla o se
    cancela?
    [lista de motivos]

## 5. Cobro

23. ¿El chofer cobra al entregar? ¿Con qué (efectivo, cheque,
    transferencia)? ¿O todo es a crédito?
    [registro de cobro]
24. ¿Qué tiene que ver el chofer: solo el total a cobrar, o también los
    precios?
    [lo que ve el chofer]

## 6. Cancelaciones y correcciones

25. ¿Quién puede cancelar un pedido? ¿Hasta qué momento?
    [reglas de cancelación]
26. Cuando algo no cuadra (el chofer entregó y no lo marcó), ¿quién lo
    corrige?
    [corrección manual del admin]

## 7. Factura

27. ¿Con qué facturan hoy (sistema, proveedor de factura electrónica)?
    [integración de facturación por país]
28. ¿Emiten la factura **antes** de que salga el camión (va el papel con la
    mercadería) o **después** de entregar?
    [en qué paso se dispara la factura]
29. Si entregan menos de lo pedido, ¿cómo lo ajustan en la factura (nota de
    crédito, factura nueva)?
    [entrega parcial + factura]
30. ¿En qué país o países facturan y en qué moneda?
    [país, moneda]

## 8. El cliente

31. ¿Cómo se enteran hoy sus clientes de dónde va su pedido? ¿Les preguntan
    mucho por WhatsApp?
    [avisos y seguimiento]
32. ¿Prefieren avisarle al cliente por correo, por WhatsApp o ambos? ¿Tienen
    el correo de sus clientes?
    [canal de avisos]
33. ¿Qué le gustaría ver al cliente en una página de seguimiento: estado,
    hora, hora estimada, quién recibió?
    [página de seguimiento]

---

## Después de la reunión

- Anotar las respuestas por empresa (p. ej. `docs/onboarding/<empresa>.md`).
- Revisar si todo cabe en las categorías fijas (Por confirmar, En
  preparación, En camino, Entregado, Cancelado). Si algo no cabe, discutirlo
  antes de prometerlo.
- Llenar los estados e interruptores de la empresa.
