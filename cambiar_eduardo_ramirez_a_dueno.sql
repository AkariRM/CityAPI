-- Cambia a Eduardo Ramirez de rol 'admin' (Supervisor) a 'dueño' (Administrador,
-- el rol oculto que opera CityPhone y Áurea sin estar atado a una sola empresa).
--
-- Además del rol, se limpian sucursal_id y empresa_id y se fija
-- empresa_preferida_id a CityPhone — mismo patrón que ya tiene el otro
-- registro con rol 'dueño' (Eduardo Magallon: empresa_id NULL,
-- empresa_preferida_id apuntando a la empresa con la que normalmente entra).
-- Sin este cambio, el usuario quedaría con rol 'dueño' pero con datos de
-- 'admin' (atado a una sucursal/empresa específica), lo cual no tiene
-- sentido para ese rol y podría causar comportamientos raros en pantallas
-- que sí distinguen por sucursal.

UPDATE usuarios
SET
  rol = 'dueño',
  sucursal_id = NULL,
  empresa_id = NULL,
  empresa_preferida_id = '62306379-e720-42e7-a048-daa7b9166296', -- CityPhone
  updated_at = now()
WHERE id = 'ca9028b4-b248-486c-868b-b8b6b981fc04'; -- Eduardo Ramirez

-- Verificar el resultado:
-- SELECT id, nombre, rol, sucursal_id, empresa_id, empresa_preferida_id FROM usuarios WHERE id = 'ca9028b4-b248-486c-868b-b8b6b981fc04';
