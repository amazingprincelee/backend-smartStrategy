import bcrypt from 'bcryptjs';
import { User } from '../models/index.js';


// Get current user profile
export const getCurrentUser = async (req, res) => {
  try {
    const user = await User.findById(req.user.id)
      .populate({
        path: 'investments.vaultId',
        select: 'vaultId tokenAddress lockDuration unlockTime status'
      });
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Remove sensitive data from response
    const userResponse = {
      id: user._id,
      email: user.email,
      walletAddress: user.walletAddress,
      profile: user.profile,
      preferences: user.preferences,
      role: user.role,
      lastLogin: user.lastLogin,
      investments: user.investments,
      isActive: user.isActive,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt
    };

    res.json({
      success: true,
      data: {
        user: userResponse
      }
    });

  } catch (error) {
    console.error('Get current user error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get user profile'
    });
  }
};

// Update user profile
export const updateUserProfile = async (req, res) => {
  try {
    const { firstName, lastName, avatar, walletAddress } = req.body;

    const user = await User.findById(req.user.id);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Update profile fields
    if (firstName !== undefined) {
      user.profile.firstName = firstName;
    }
    if (lastName !== undefined) {
      user.profile.lastName = lastName;
    }
    if (avatar !== undefined) {
      user.profile.avatar = avatar;
    }

    // Update wallet address if provided and not already in use
    if (walletAddress !== undefined && walletAddress !== user.walletAddress) {
      const existingUser = await User.findOne({ 
        walletAddress: walletAddress.toLowerCase(),
        _id: { $ne: user._id }
      });
      
      if (existingUser) {
        return res.status(400).json({
          success: false,
          message: 'This wallet address is already associated with another account'
        });
      }
      
      user.walletAddress = walletAddress.toLowerCase();
    }

    await user.save();

    // Remove sensitive data from response
    const userResponse = {
      id: user._id,
      email: user.email,
      walletAddress: user.walletAddress,
      profile: user.profile,
      preferences: user.preferences,
      role: user.role,
      lastLogin: user.lastLogin,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt
    };

    res.json({
      success: true,
      message: 'Profile updated successfully',
      data: {
        user: userResponse
      }
    });

  } catch (error) {
    console.error('Update profile error:', error);
    
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map(err => ({
        field: err.path,
        message: err.message
      }));
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors
      });
    }

    res.status(500).json({
      success: false,
      message: 'Profile update failed'
    });
  }
};

// Update user preferences
export const updateUserPreferences = async (req, res) => {
  try {
    const { emailNotifications, inAppNotifications, theme } = req.body;

    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Update theme preference
    if (theme !== undefined) {
      const validThemes = ['light', 'dark', 'system'];
      if (!validThemes.includes(theme)) {
        return res.status(400).json({ success: false, message: 'Invalid theme value' });
      }
      user.preferences.theme = theme;
    }

    // Update email notification preferences
    if (emailNotifications) {
      user.preferences.emailNotifications = {
        ...user.preferences.emailNotifications.toObject?.() || user.preferences.emailNotifications,
        ...emailNotifications
      };
    }

    // Update in-app notification preferences
    if (inAppNotifications) {
      user.preferences.inAppNotifications = {
        ...user.preferences.inAppNotifications.toObject?.() || user.preferences.inAppNotifications,
        ...inAppNotifications
      };
    }

    await user.save();

    res.json({
      success: true,
      message: 'Preferences updated successfully',
      data: {
        preferences: user.preferences
      }
    });

  } catch (error) {
    console.error('Update preferences error:', error);
    
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map(err => ({
        field: err.path,
        message: err.message
      }));
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors
      });
    }

    res.status(500).json({
      success: false,
      message: 'Preferences update failed'
    });
  }
};

// Change password
export const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    // Find user with password field
    const user = await User.findById(req.user.id).select('+password');
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Verify current password
    const isPasswordValid = await bcrypt.compare(currentPassword, user.password);
    
    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Current password is incorrect'
      });
    }

    // Check if new password is same as current
    const isSamePassword = await bcrypt.compare(newPassword, user.password);
    if (isSamePassword) {
      return res.status(400).json({
        success: false,
        message: 'New password must be different from current password'
      });
    }

    // Hash new password
    const saltRounds = 12;
    const hashedPassword = await bcrypt.hash(newPassword, saltRounds);

    // Update password
    user.password = hashedPassword;
    await user.save();

    res.json({
      success: true,
      message: 'Password changed successfully'
    });

  } catch (error) {
    console.error('Change password error:', error);
    
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map(err => ({
        field: err.path,
        message: err.message
      }));
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors
      });
    }

    res.status(500).json({
      success: false,
      message: 'Password change failed'
    });
  }
};

// Get user investments
export const getUserInvestments = async (req, res) => {
  try {
    const user = await User.findById(req.user.id)
      .populate({
        path: 'investments.vaultId',
        select: 'vaultId tokenAddress tokenSymbol tokenName lockDuration unlockTime status totalDeposited balance'
      });
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Filter and format investments
    const investments = user.investments.map(inv => ({
      id: inv._id,
      vaultId: inv.vaultId?.vaultId,
      vault: inv.vaultId,
      amount: inv.amount,
      status: inv.status,
      returns: inv.returns,
      createdAt: inv.createdAt,
      maturityDate: inv.maturityDate
    }));

    // Calculate totals
    const totalInvested = investments.reduce((sum, inv) => sum + (inv.amount || 0), 0);
    const activeInvestments = investments.filter(inv => inv.status === 'active').length;
    const completedInvestments = investments.filter(inv => inv.status === 'completed').length;
    const totalReturns = investments.reduce((sum, inv) => sum + (inv.returns || 0), 0);

    res.json({
      success: true,
      data: {
        investments,
        summary: {
          total: investments.length,
          active: activeInvestments,
          completed: completedInvestments,
          totalInvested,
          totalReturns
        }
      }
    });

  } catch (error) {
    console.error('Get user investments error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get user investments'
    });
  }
};

// Get user statistics
export const getUserStatistics = async (req, res) => {
  try {
    const user = await User.findById(req.user.id)
      .populate('investments.vaultId');
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Calculate statistics
    const totalInvestments = user.investments.length;
    const activeInvestments = user.investments.filter(inv => inv.status === 'active').length;
    const completedInvestments = user.investments.filter(inv => inv.status === 'completed').length;
    const pendingInvestments = user.investments.filter(inv => inv.status === 'pending').length;
    
    const totalInvested = user.investments.reduce((sum, inv) => sum + (inv.amount || 0), 0);
    const totalReturns = user.investments.reduce((sum, inv) => sum + (inv.returns || 0), 0);
    
    // Calculate average lock duration for active investments
    const activeInvs = user.investments.filter(inv => inv.status === 'active');
    const avgLockDuration = activeInvs.length > 0
      ? activeInvs.reduce((sum, inv) => {
          const vault = inv.vaultId;
          return sum + (vault?.lockDuration || 0);
        }, 0) / activeInvs.length
      : 0;

    // Get upcoming maturities (within next 30 days)
    const thirtyDaysFromNow = new Date();
    thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);
    
    const upcomingMaturities = user.investments.filter(inv => 
      inv.status === 'active' && 
      inv.maturityDate && 
      new Date(inv.maturityDate) <= thirtyDaysFromNow
    ).length;

    res.json({
      success: true,
      data: {
        statistics: {
          totalInvestments,
          activeInvestments,
          completedInvestments,
          pendingInvestments,
          totalInvested,
          totalReturns,
          avgLockDuration: Math.round(avgLockDuration),
          upcomingMaturities,
          accountAge: Math.floor((Date.now() - new Date(user.createdAt).getTime()) / (1000 * 60 * 60 * 24)) // days
        }
      }
    });

  } catch (error) {
    console.error('Get user statistics error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get user statistics'
    });
  }
};

// Delete user account
export const deleteUserAccount = async (req, res) => {
  try {
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({
        success: false,
        message: 'Password is required to delete account'
      });
    }

    // Find user with password field
    const user = await User.findById(req.user.id).select('+password');
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.password);
    
    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Incorrect password'
      });
    }

    // Check for active investments
    const hasActiveInvestments = user.investments.some(inv => inv.status === 'active');
    
    if (hasActiveInvestments) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete account with active investments. Please withdraw all funds first.'
      });
    }

    // Soft delete - deactivate account instead of removing
    user.isActive = false;
    user.email = `deleted_${Date.now()}_${user.email}`; // Anonymize email
    await user.save();

    res.json({
      success: true,
      message: 'Account deleted successfully'
    });

  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete account'
    });
  }
};

// Link wallet address
export const linkWalletAddress = async (req, res) => {
  try {
    const { walletAddress } = req.body;

    if (!walletAddress) {
      return res.status(400).json({
        success: false,
        message: 'Wallet address is required'
      });
    }

    const user = await User.findById(req.user.id);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Check if wallet is already linked to this user
    if (user.walletAddress && user.walletAddress.toLowerCase() === walletAddress.toLowerCase()) {
      return res.status(400).json({
        success: false,
        message: 'This wallet is already linked to your account'
      });
    }

    // Check if wallet is linked to another account
    const existingUser = await User.findOne({ 
      walletAddress: walletAddress.toLowerCase(),
      _id: { $ne: user._id }
    });
    
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'This wallet address is already associated with another account'
      });
    }

    // Update wallet address
    user.walletAddress = walletAddress.toLowerCase();
    await user.save();

    res.json({
      success: true,
      message: 'Wallet address linked successfully',
      data: {
        walletAddress: user.walletAddress
      }
    });

  } catch (error) {
    console.error('Link wallet error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to link wallet address'
    });
  }
};

// Unlink wallet address
export const unlinkWalletAddress = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (!user.walletAddress) {
      return res.status(400).json({
        success: false,
        message: 'No wallet address is currently linked'
      });
    }

    // Check for active investments
    const hasActiveInvestments = user.investments.some(inv => inv.status === 'active');
    
    if (hasActiveInvestments) {
      return res.status(400).json({
        success: false,
        message: 'Cannot unlink wallet with active investments'
      });
    }

    // Unlink wallet
    user.walletAddress = undefined;
    await user.save();

    res.json({
      success: true,
      message: 'Wallet address unlinked successfully'
    });

  } catch (error) {
    console.error('Unlink wallet error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to unlink wallet address'
    });
  }
};

// Get user activity log
export const getUserActivity = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    
    const user = await User.findById(req.user.id)
      .populate({
        path: 'investments.vaultId',
        select: 'vaultId tokenSymbol'
      });
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Format activity from investments
    const activities = user.investments
      .map(inv => ({
        type: 'investment',
        action: inv.status,
        vaultId: inv.vaultId?.vaultId,
        tokenSymbol: inv.vaultId?.tokenSymbol,
        amount: inv.amount,
        timestamp: inv.createdAt
      }))
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    // Add login activity
    if (user.lastLogin) {
      activities.unshift({
        type: 'login',
        action: 'login',
        timestamp: user.lastLogin
      });
    }

    // Pagination
    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    const paginatedActivities = activities.slice(startIndex, endIndex);

    res.json({
      success: true,
      data: {
        activities: paginatedActivities,
        pagination: {
          currentPage: parseInt(page),
          totalPages: Math.ceil(activities.length / limit),
          totalItems: activities.length,
          itemsPerPage: parseInt(limit)
        }
      }
    });

  } catch (error) {
    console.error('Get user activity error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get user activity'
    });
  }
};