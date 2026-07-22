
CREATE POLICY "users manage own build-sources"
ON storage.objects FOR ALL TO authenticated
USING (bucket_id = 'build-sources' AND (storage.foldername(name))[1] = auth.uid()::text)
WITH CHECK (bucket_id = 'build-sources' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "users read own build-artifacts"
ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'build-artifacts' AND (storage.foldername(name))[1] = auth.uid()::text);
