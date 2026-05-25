-- 20260525_luciana_storage_bucket.sql
-- Crea bucket public 'luciana-photos' para almacenar fotos que el admin
-- adjunta a las preguntas a Luciana. Mismo patron que 'maid-photos':
-- bucket publico (sin URLs firmadas) + policies permisivas para INSERT/ALL
-- con la anon key. El backend usa la URL publica para fetchear la foto y
-- convertirla a base64 antes de pasarla a Anthropic vision.
--
-- La compresion client-side (compressImage en index.html) deja los JPEG
-- en ~200-500KB, por eso no se setea file_size_limit.

INSERT INTO storage.buckets (id, name, public)
VALUES ('luciana-photos', 'luciana-photos', true);

CREATE POLICY "luciana-photos allow anon uploads"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'luciana-photos');

CREATE POLICY "luciana-photos allow all anon"
  ON storage.objects FOR ALL
  USING (bucket_id = 'luciana-photos')
  WITH CHECK (bucket_id = 'luciana-photos');
