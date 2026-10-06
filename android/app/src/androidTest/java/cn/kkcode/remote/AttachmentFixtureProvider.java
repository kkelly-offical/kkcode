package cn.kkcode.remote;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import android.util.Base64;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FileNotFoundException;

/** Fixture provider runs in the test APK's process without target Kotlin libs. */
public final class AttachmentFixtureProvider extends ContentProvider {
    public static final String PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2lGkAAAAASUVORK5CYII=";
    @Override public boolean onCreate() { return true; }
    @Override public String getType(Uri uri) { return "image/png"; }
    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] args, String order) {
        MatrixCursor cursor = new MatrixCursor(new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE});
        cursor.addRow(new Object[]{"剪贴板截图.png", Base64.decode(PNG, Base64.NO_WRAP).length});
        return cursor;
    }
    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!"/image".equals(uri.getPath()) || !"r".equals(mode)) throw new FileNotFoundException();
        File file = new File(getContext().getCacheDir(), "clipboard-fixture.png");
        try (FileOutputStream output = new FileOutputStream(file)) { output.write(Base64.decode(PNG, Base64.NO_WRAP)); }
        catch (java.io.IOException error) { throw new FileNotFoundException("Fixture unavailable"); }
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
    }
    @Override public Uri insert(Uri uri, ContentValues values) { return null; }
    @Override public int delete(Uri uri, String selection, String[] args) { return 0; }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { return 0; }
}
