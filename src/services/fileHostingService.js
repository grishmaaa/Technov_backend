import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';

export const uploadFile = async (filePath) => {
    const fileBuffer = await fs.readFile(filePath);
    const fileName = path.basename(filePath);

    const form = new FormData();
    const blob = new Blob([fileBuffer]);
    form.append('file', blob, fileName);

    const headers = {};
    if (process.env.FILE_IO_API_KEY) {
        headers.Authorization = `Bearer ${process.env.FILE_IO_API_KEY}`;
    }

    const response = await axios.post('https://file.io', form, { headers });
    const publicUrl = response?.data?.link || response?.data?.url;

    if (!publicUrl) {
        throw new Error('File upload failed: missing public URL');
    }

    return publicUrl;
};
