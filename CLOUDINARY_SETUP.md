# Cloudinary Setup Instructions

The Beast Inventory System now supports image uploads via Cloudinary for:
- **Quality Control**: Upload photos of quality issues when rejecting tasks
- **Process Tutorials**: Upload process instruction photos

## Setup Steps

### 1. Create a Cloudinary Account

1. Go to [cloudinary.com](https://cloudinary.com)
2. Sign up for a free account
3. After signing in, go to your Dashboard

### 2. Get Your Credentials

From your Cloudinary Dashboard, you'll see:
- **Cloud Name** (e.g., `dxyz123abc`)
- **API Key** (e.g., `123456789012345`)
- **API Secret** (e.g., `AbCdEfGhIjKlMnOpQrStUvWxYz`)

### 3. Update Local Environment Variables

Edit your `.env` file in the project root and replace the placeholders:

```bash
CLOUDINARY_CLOUD_NAME="your-cloud-name-here"
CLOUDINARY_API_KEY="your-api-key-here"
CLOUDINARY_API_SECRET="your-api-secret-here"
```

### 4. Update Render.com Environment Variables

1. Go to your Render.com dashboard
2. Select your `beast-inventory-system` web service
3. Go to the **Environment** tab
4. Add these three environment variables:
   - `CLOUDINARY_CLOUD_NAME` = your cloud name
   - `CLOUDINARY_API_KEY` = your API key
   - `CLOUDINARY_API_SECRET` = your API secret
5. Save and redeploy

### 5. (Optional) Create Upload Preset

For enhanced security and features:

1. In Cloudinary Dashboard, go to **Settings** → **Upload**
2. Scroll down to **Upload presets**
3. Click **Add upload preset**
4. Set:
   - **Preset name**: `beast_inventory_unsigned`
   - **Signing Mode**: `Unsigned` (or `Signed` for more security)
   - **Folder**: `beast-inventory`
   - **Access Mode**: `Public`
5. Save the preset

## Image Storage Structure

Images will be organized in Cloudinary folders:
- `beast-inventory/quality-control/` - Quality issue photos
- `beast-inventory/tutorials/` - Process tutorial photos

## Features

- **Automatic optimization**: Images are automatically optimized for web
- **Responsive delivery**: Cloudinary serves the best format (WebP, etc.)
- **Size limits**: 5MB max file size
- **Supported formats**: PNG, JPG, GIF

## Testing

After setup:

1. **Quality Control**:
   - Go to Quality Control page
   - Click "Review" on a pending time entry
   - Click "Reject" on a task
   - Use the image upload section to upload a photo
   - Verify the photo appears in the rejection details

2. **Process Tutorials**:
   - Go to Process Tutorials page
   - Create or edit a tutorial
   - Use the "Process Photo" upload section
   - Verify the photo appears in the tutorial display

## Troubleshooting

### "Failed to upload image to Cloudinary"
- Check that your credentials are correct in `.env`
- Verify your Cloudinary account is active
- Check that you haven't exceeded free tier limits

### Images not appearing
- Check browser console for errors
- Verify the Cloudinary Cloud Name is correct
- Check that images are being uploaded to the correct folder

### Production deployment failing
- Ensure all three environment variables are set in Render.com
- Check Render logs for specific error messages
- Verify credentials work in Cloudinary dashboard

## Free Tier Limits

Cloudinary's free tier includes:
- 25 GB storage
- 25 GB monthly bandwidth
- 25,000 transformations/month

This should be more than sufficient for the Beast Inventory System's needs.

## Security Notes

- Never commit actual API credentials to git
- Keep your `.env` file in `.gitignore`
- Use unsigned uploads only if you trust your users
- Consider signed uploads for production environments
